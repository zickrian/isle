// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Which models each AI's plan allows, by their own names, and the plan: Claude Code's cached catalog,
//! Codex's `model/list`, `agy models`, `grok models`, `opencode models`. Looked at only when due (see `due`);
//! kept in models.json.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use log::warn;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use zbus::object_server::InterfaceRef;

use super::AssistantService;
use super::brain::Provider;
use crate::clock::now_ms;
use crate::store::Store;

/// Claude's aliases Isle offers, in order; never Fable (the user's decision).
pub const CLAUDE_ALIASES: [&str; 3] = ["opus", "sonnet", "haiku"];
/// Settings or a refused model asks again no sooner than this after the last look.
const ASKED_EVERY: Duration = Duration::from_secs(60);
/// A plan change seen in the usage: no sooner than this after the last look.
const PLAN_EVERY: Duration = Duration::from_secs(10 * 60);
/// As the assistant opens: agy's, Grok's and opencode's lists (they ask servers) at most this often, and
/// Codex's only if never.
const WARM_EVERY: Duration = Duration::from_secs(6 * 3600);
const CODEX_TIMEOUT: Duration = Duration::from_secs(30);
const AGY_TIMEOUT: Duration = Duration::from_secs(20);
const GROK_TIMEOUT: Duration = Duration::from_secs(30);
const OPENCODE_TIMEOUT: Duration = Duration::from_secs(30);

/// One AI's plan and the models it allows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Catalog {
    /// As the account has it ("Team", "Pro"); empty when it cannot be read (agy) or there is none (opencode).
    pub plan: String,
    /// What it answers with when Settings says "default" (empty: the CLI's own choice), and its name.
    pub default: String,
    pub default_name: String,
    pub models: Vec<Model>,
    pub checked_ms: i64,
}

/// A model as the CLI lists it: the id it takes and the name people see.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Model {
    pub id: String,
    pub name: String,
}

/// By provider id ("claude", "codex", "agy"): only those installed and signed in.
pub type Catalogs = BTreeMap<String, Catalog>;

impl Catalog {
    /// Whether the plan allows `model`: listed, or its default (empty: the CLI's own).
    pub fn allows(&self, model: &str) -> bool {
        model.is_empty() || model == self.default || self.models.iter().any(|m| m.id == model)
    }

    /// What it says, the time it was looked at aside: to tell whether it changed.
    pub fn signature(&self) -> String {
        let ids: Vec<&str> = self.models.iter().map(|m| m.id.as_str()).collect();
        format!("{}|{}|{}", self.plan, self.default, ids.join(","))
    }

    /// A listed model's name, or the default's.
    fn name_of(&self, id: &str) -> Option<&str> {
        let listed = self
            .models
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.as_str());
        listed.or((id == self.default).then_some(self.default_name.as_str()))
    }
}

/// Why its models are looked at; each has its own pace (see `due`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// Settings opened (`RefreshModels`).
    Asked,
    /// The usage shows another plan than the catalog's.
    Plan,
    /// The assistant opens.
    Warm,
    /// The AI refused the model it was asked with.
    Refused,
}

/// What is kept in models.json.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    catalogs: Catalogs,
    /// Every model's name once listed ("codex/gpt-6-astra"), to name a pick the plan no longer has.
    names: BTreeMap<String, String>,
    /// Per provider, the pick last told as stood in for (see `tell`).
    switched: BTreeMap<String, String>,
}

/// The catalogs and the plan looks in progress, behind one lock.
struct Shared {
    saved: Saved,
    store: Store<Saved>,
    /// The plan the usage read saw last, per AI, until a look for it runs (see `run`).
    plan_pending: HashMap<&'static str, String>,
    /// The plan a look ran for last, per AI: not looked at again for it, even if looking failed.
    plan_looked: HashMap<&'static str, String>,
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| {
    let mut store = Store::new("models");
    Mutex::new(Shared {
        saved: store.load(),
        store,
        plan_pending: HashMap::new(),
        plan_looked: HashMap::new(),
    })
});

/// Where `refresh` hands its requests to `run`.
static REQUESTS: OnceLock<mpsc::UnboundedSender<(Provider, Why)>> = OnceLock::new();

/// Locks the shared state, carrying on past a panic that poisoned it.
fn shared() -> MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Every catalog as last found.
pub fn current() -> Catalogs {
    shared().saved.catalogs.clone()
}

/// The `Models` property: JSON `{claude: {plan, default, default_name, models: [{id, name}], checked_ms}, …}`.
pub fn json() -> String {
    serde_json::to_string(&shared().saved.catalogs).unwrap_or_else(|_| "{}".into())
}

/// Asks `run` to look at `providers`' models again, in the background, as `why` allows.
pub fn refresh(providers: &[Provider], why: Why) {
    if let Some(requests) = REQUESTS.get() {
        for provider in providers {
            requests.send((*provider, why)).ok();
        }
    }
}

/// Whether the AI assistant is turned on in Settings (see `plan_seen`).
static ASSISTANT_ON: AtomicBool = AtomicBool::new(true);

/// The assistant turned on or off in Settings: off, no AI is started to list its models for a plan.
pub fn set_assistant_on(on: bool) {
    ASSISTANT_ON.store(on, Ordering::Relaxed);
}

/// The usage read `provider`'s plan: if it differs from the catalog's, the models are looked at again.
/// Only for a catalog already listed, so no AI is started while the assistant is unused or off.
pub fn plan_seen(provider: &str, plan: &str) {
    let Some(provider) = Provider::from_id(provider) else {
        return;
    };
    if !ASSISTANT_ON.load(Ordering::Relaxed) {
        return;
    }
    let mut shared = shared();
    let other = shared
        .saved
        .catalogs
        .get(provider.id())
        .is_some_and(|c| c.plan != plan);
    // A look that ran for this plan (failed, or the CLI names the plan otherwise) is not asked for again.
    let looked = shared
        .plan_looked
        .get(provider.id())
        .is_some_and(|last| last == plan);
    if plan.is_empty() || !other || looked {
        return;
    }
    shared.plan_pending.insert(provider.id(), plan.to_owned());
    drop(shared);
    refresh(&[provider], Why::Plan);
}

/// `model`'s name for `provider` ("Opus 5.5", "GPT-6-Astra"), as last listed; "" is its default.
pub fn name(provider: Provider, model: &str) -> String {
    let shared = shared();
    let catalog = shared.saved.catalogs.get(provider.id());
    if let Some(name) = catalog
        .and_then(|c| c.name_of(model))
        .filter(|n| !n.is_empty())
    {
        return name.to_owned();
    }
    if model.is_empty() {
        return format!("{}’s default", provider.name());
    }
    let known = shared
        .saved
        .names
        .get(&format!("{}/{model}", provider.id()));
    known.cloned().unwrap_or_else(|| match provider {
        Provider::Claude => title_case(model),
        // "grok-4.6", never listed here: "Grok 4.6", as Grok names its models.
        Provider::Grok => title_case(&model.replace('-', " ")),
        _ => model.to_owned(),
    })
}

/// What the island is told of a model stood in for: (plan, picked, used), by their names.
pub type Switch = (String, String, String);

/// `provider` runs `used` instead of `instead_of` (`None`: what was picked). Told once per pick, and
/// anew once it was allowed again in between.
pub fn tell(provider: Provider, instead_of: Option<&str>, used: &str) -> Option<Switch> {
    let tell = {
        let mut shared = shared();
        let before = shared.saved.switched.clone();
        let tell = told(&mut shared.saved.switched, provider.id(), instead_of);
        if shared.saved.switched != before {
            let shared = &*shared;
            shared.store.save(&shared.saved);
        }
        tell
    };
    let picked = instead_of.filter(|_| tell)?;
    // Refused though its plan lists it, or Fable (Isle's choice, not the plan's): no plan is named.
    let plan = current()
        .remove(provider.id())
        .filter(|c| !c.allows(picked) && !is_fable(picked))
        .map(|c| c.plan)
        .unwrap_or_default();
    Some((plan, name(provider, picked), name(provider, used)))
}

/// Whether `instead_of` is news for `provider`, kept in `switched` (see `tell`).
fn told(switched: &mut BTreeMap<String, String>, provider: &str, instead_of: Option<&str>) -> bool {
    match instead_of {
        None => {
            switched.remove(provider);
            false
        }
        Some(picked) => {
            switched
                .insert(provider.to_owned(), picked.to_owned())
                .as_deref()
                != Some(picked)
        }
    }
}

/// What `provider` answers with when what was wanted cannot be: its catalog's default, else Claude's
/// Opus (never Fable), else the CLI's own.
pub fn fallback(provider: Provider, catalog: Option<&Catalog>) -> String {
    match catalog
        .map(|c| c.default.as_str())
        .filter(|d| !d.is_empty())
    {
        Some(default) => default.to_owned(),
        None if provider == Provider::Claude => "opus".into(),
        None => String::new(),
    }
}

/// Whether `model` is a Fable one, which Isle never uses.
pub fn is_fable(model: &str) -> bool {
    model.to_lowercase().contains("fable")
}

/// Looks at the models as `refresh` asks, one AI at a time, and publishes what changed (`Models`).
pub async fn run(iface: InterfaceRef<AssistantService>) {
    let (sender, mut requests) = mpsc::unbounded_channel();
    if REQUESTS.set(sender).is_err() {
        return;
    }
    let mut tried: HashMap<&'static str, Instant> = HashMap::new();
    while let Some((provider, why)) = requests.recv().await {
        let catalog = current().remove(provider.id());
        let since = tried.get(provider.id()).map(Instant::elapsed);
        if !due(provider, why, catalog.as_ref(), since, now_ms()) {
            continue;
        }
        tried.insert(provider.id(), Instant::now());
        // Any look counts for the plan the usage saw: it is not asked for again.
        {
            let mut shared = shared();
            if let Some(plan) = shared.plan_pending.remove(provider.id()) {
                shared.plan_looked.insert(provider.id(), plan);
            }
        }
        let found = read(provider).await;
        if !shared().update(provider, found) {
            continue;
        }
        let service = iface.get().await;
        if let Err(err) = service.models_changed(iface.signal_emitter()).await {
            warn!("could not publish the AIs' models: {err}");
        }
    }
}

/// Whether to look at `provider`'s models now, for `why`, last tried `since` ago (`None`: never).
fn due(
    provider: Provider,
    why: Why,
    catalog: Option<&Catalog>,
    since: Option<Duration>,
    now: i64,
) -> bool {
    let waited = |least: Duration| since.is_none_or(|since| since >= least);
    if provider == Provider::Claude {
        // A file of Claude Code's own: nothing to start, so whenever asked.
        return true;
    }
    match why {
        Why::Asked | Why::Refused => waited(ASKED_EVERY),
        Why::Plan => waited(PLAN_EVERY),
        Why::Warm => {
            let old = catalog.is_none_or(|c| {
                matches!(
                    provider,
                    Provider::Agy | Provider::Grok | Provider::Opencode
                ) && now - c.checked_ms >= i64::try_from(WARM_EVERY.as_millis()).unwrap_or(0)
            });
            old && waited(WARM_EVERY)
        }
    }
}

/// What looking found.
enum Found {
    /// Not installed, or signed out: it is left out.
    Gone,
    Catalog(Catalog),
    /// Offline, or it failed: the last catalog stands.
    Failed,
}

impl Shared {
    /// Takes in what was found for `provider`; whether `Models` changed.
    fn update(&mut self, provider: Provider, found: Found) -> bool {
        let id = provider.id();
        let before = self.saved.catalogs.get(id).cloned();
        match found {
            Found::Failed => return false,
            Found::Gone => {
                self.saved.catalogs.remove(id);
            }
            Found::Catalog(mut catalog) => {
                // Claude's is read whenever asked: unchanged, it is not news.
                if let Some(before) = before.as_ref().filter(|_| provider == Provider::Claude)
                    && before.signature() == catalog.signature()
                {
                    catalog.checked_ms = before.checked_ms;
                }
                for model in &catalog.models {
                    let key = format!("{id}/{}", model.id);
                    self.saved.names.insert(key, model.name.clone());
                }
                self.saved.catalogs.insert(id.to_owned(), catalog);
            }
        }
        let changed = self.saved.catalogs.get(id) != before.as_ref();
        if changed {
            self.store.save(&self.saved);
        }
        changed
    }
}

/// `provider`'s plan and models now.
async fn read(provider: Provider) -> Found {
    // opencode answers with OpenCode's free models signed in or not.
    let usable = provider.signed_in() || provider == Provider::Opencode;
    let Some(program) = provider.program().filter(|_| usable) else {
        return Found::Gone;
    };
    let read = match provider {
        Provider::Claude => tokio::task::spawn_blocking(read_claude)
            .await
            .map_err(anyhow::Error::from),
        Provider::Codex => {
            tokio::time::timeout(CODEX_TIMEOUT, super::codex::Codex::models(&program))
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("no answer in time")))
                .map(|(account, pages)| codex_catalog(&account, &pages))
        }
        Provider::Agy => tokio::time::timeout(AGY_TIMEOUT, super::agy::models(&program))
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("no answer in time")))
            .map(|listed| agy_catalog(&listed)),
        Provider::Grok => tokio::time::timeout(GROK_TIMEOUT, super::grok::models(&program))
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("no answer in time")))
            .map(|(listed, cache, settings)| grok_catalog(&listed, &cache, &settings)),
        Provider::Opencode => {
            let listed = tokio::time::timeout(OPENCODE_TIMEOUT, super::opencode::models(&program))
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("no answer in time")));
            let plan = super::opencode::plan();
            // Go's own list, for a Go plan only: a model Go dropped is not offered though opencode lists it.
            let go = match (&listed, plan) {
                (Ok(_), "OpenCode Go") => super::opencode::go_models().await,
                _ => None,
            };
            listed.map(|listed| {
                opencode_catalog(&listed, &super::opencode::preferred(), plan, go.as_deref())
            })
        }
    };
    match read {
        Ok(catalog) if !catalog.models.is_empty() => Found::Catalog(Catalog {
            checked_ms: now_ms(),
            ..catalog
        }),
        Ok(_) => {
            warn!("{} listed no models", provider.name());
            Found::Failed
        }
        Err(err) => {
            warn!("could not list {}'s models: {err:#}", provider.name());
            Found::Failed
        }
    }
}

/// Null when the file is missing or not JSON.
fn read_json(path: &std::path::Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Claude's plan as its sign-in says and Claude Code names it ("Team", "Max"); empty without one.
pub fn claude_plan() -> String {
    let credentials = read_json(&super::claude::config_dir().join(".credentials.json"));
    let state = read_json(&super::claude::state_file());
    claude_plan_of(&credentials["claudeAiOauth"], &state["oauthAccount"])
}

/// The plan of a sign-in (`claudeAiOauth`) and its account (`oauthAccount` in `.claude.json`).
fn claude_plan_of(sign_in: &Value, account: &Value) -> String {
    let named = ["plan_display_name", "planDisplayName"]
        .iter()
        .find_map(|key| {
            account[key]
                .as_str()
                .or(account["organization"][key].as_str())
        });
    if let Some(name) = named.filter(|name| !name.is_empty()) {
        return name.to_owned();
    }
    let text = |value: &Value| value.as_str().unwrap_or_default().to_lowercase();
    let mut kind = text(&sign_in["subscriptionType"]);
    if kind.is_empty() {
        kind = text(&account["organizationType"])
            .trim_start_matches("claude_")
            .to_owned();
    }
    // As Claude Code names them ("Claude Team"): no seat or usage tier.
    match kind.as_str() {
        "" => String::new(),
        "pro" => "Pro".into(),
        "max" => "Max".into(),
        "team" => "Team".into(),
        "enterprise" => "Enterprise".into(),
        other => title_case(other),
    }
}

/// Claude's catalog as Claude Code keeps it for the account signed in, else its aliases by family name.
fn read_claude() -> Catalog {
    let state = read_json(&super::claude::state_file());
    let plan = if super::claude::uses_api_key() {
        "API key".to_owned()
    } else {
        let credentials = read_json(&super::claude::config_dir().join(".credentials.json"));
        match claude_plan_of(&credentials["claudeAiOauth"], &state["oauthAccount"]) {
            plan if plan.is_empty() => "API key".to_owned(),
            plan => plan,
        }
    };
    // `<orgUuid>-<hash>-cc.json`, the newest for this organization: another one is another account's.
    let org = state["oauthAccount"]["organizationUuid"]
        .as_str()
        .filter(|org| !org.is_empty() && plan != "API key");
    let dir = super::claude::config_dir().join("cache/model-catalog");
    let cached = org.and_then(|org| {
        let modified =
            |path: &std::path::PathBuf| std::fs::metadata(path).and_then(|m| m.modified()).ok();
        std::fs::read_dir(&dir)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                name.starts_with(&format!("{org}-")) && name.ends_with("-cc.json")
            })
            .max_by_key(modified)
    });
    claude_catalog(
        &cached.map(|path| read_json(&path)).unwrap_or_default(),
        plan,
    )
}

/// Claude's aliases this plan has, each named as the model it means now ("opus": "Opus 5.5"), and the
/// account's default (Fable's stands as Opus). Without a catalog, the aliases by family name.
fn claude_catalog(cached: &Value, plan: String) -> Catalog {
    // As cached: `{catalog: {config, state}}`; as the server sends it, `model_selector_config: [{…}]`.
    let root = if cached["catalog"].is_object() {
        &cached["catalog"]
    } else {
        cached
    };
    let first = |key: &str| match &root[key] {
        Value::Array(items) => items.first().cloned().unwrap_or_default(),
        other => other.clone(),
    };
    let config = match first("config") {
        Value::Null => first("model_selector_config"),
        config => config,
    };
    let state = match first("state") {
        Value::Null => first("model_selector_state"),
        state => state,
    };
    let listed: Vec<&Value> = config["models"].as_array().into_iter().flatten().collect();
    let model = |id: &str| listed.iter().find(|m| m["id"] == id).copied();
    let family = |m: &Value| {
        m["runtime"]["family"]
            .as_str()
            .or(m["short_name"].as_str())
            .unwrap_or_default()
            .to_lowercase()
    };
    // What each alias means now: as the catalog says, else its family's newest main model.
    let targets: Vec<(&str, &Value)> = CLAUDE_ALIASES
        .iter()
        .filter_map(|alias| {
            let target = config["provider_alias_targets"][alias]["default"].as_str();
            let found = match target {
                Some(id) => model(id),
                None => listed
                    .iter()
                    .find(|m| m["section"] == "main" && family(m) == *alias)
                    .copied(),
            };
            Some((*alias, found?))
        })
        .collect();
    let name_of = |m: &Value| m["name"].as_str().unwrap_or_default().to_owned();
    let models: Vec<Model> = if listed.is_empty() {
        CLAUDE_ALIASES
            .iter()
            .map(|alias| Model {
                id: (*alias).into(),
                name: title_case(alias),
            })
            .collect()
    } else {
        targets
            .iter()
            .map(|(alias, m)| Model {
                id: (*alias).into(),
                name: name_of(m),
            })
            .collect()
    };
    let wanted = state["model"].as_str().unwrap_or_default();
    // "claude-opus-5-5[1m]" is Opus 5.5 with more context.
    let wanted = wanted.split('[').next().unwrap_or_default();
    let alias = |id: &str| targets.iter().find(|(_, m)| m["id"] == id);
    let (default, default_name) = if wanted.is_empty() {
        (String::new(), String::new())
    } else if is_fable(wanted) || model(wanted).is_some_and(|m| is_fable(&family(m))) {
        let opus = models.iter().find(|m| m.id == "opus");
        opus.map_or_else(Default::default, |m| (m.id.clone(), m.name.clone()))
    } else if let Some((alias, m)) = alias(wanted) {
        ((*alias).into(), name_of(m))
    } else {
        (
            wanted.to_owned(),
            model(wanted).map(name_of).unwrap_or_default(),
        )
    };
    Catalog {
        plan,
        default,
        default_name,
        models,
        checked_ms: 0,
    }
}

/// ChatGPT's plan as Codex names it ("prolite" is Pro, "pro" Pro (More)).
pub fn codex_plan(plan: &str) -> String {
    match plan.to_lowercase().as_str() {
        "free" => "Free".into(),
        "go" => "Go".into(),
        "plus" => "Plus".into(),
        "prolite" | "pro_lite" => "Pro".into(),
        "pro" => "Pro (More)".into(),
        "promax" | "pro_max" => "Pro (Max)".into(),
        "team" => "Team".into(),
        "business" => "Business".into(),
        "enterprise" => "Enterprise".into(),
        "edu" => "Edu".into(),
        other => title_case(other),
    }
}

/// Codex's catalog from `account/read` and the pages of `model/list`: the models it shows, by name.
fn codex_catalog(account: &Value, pages: &[Value]) -> Catalog {
    let account = &account["account"];
    let plan = match account["planType"].as_str() {
        Some(plan) if !plan.is_empty() => codex_plan(plan),
        _ if account["type"] == "apiKey" => "API key".into(),
        _ => String::new(),
    };
    let mut catalog = Catalog {
        plan,
        ..Catalog::default()
    };
    let listed = pages
        .iter()
        .flat_map(|page| page["data"].as_array().into_iter().flatten());
    for model in listed.filter(|m| m["hidden"] != true) {
        let Some(id) = model["model"].as_str().or(model["id"].as_str()) else {
            continue;
        };
        let name = model["displayName"]
            .as_str()
            .filter(|n| !n.is_empty())
            .unwrap_or(id);
        if model["isDefault"] == true {
            catalog.default = id.to_owned();
            catalog.default_name = name.to_owned();
        }
        catalog.models.push(Model {
            id: id.to_owned(),
            name: name.to_owned(),
        });
    }
    catalog
}

/// agy's catalog from `agy models` (`id<TAB>name` lines); its plan cannot be read, and it marks no default.
fn agy_catalog(listed: &str) -> Catalog {
    let models = listed
        .lines()
        .filter_map(|line| {
            let (id, name) = line.split_once('\t')?;
            let (id, name) = (id.trim(), name.trim());
            (!id.is_empty() && !id.contains(char::is_whitespace)).then(|| Model {
                id: id.to_owned(),
                name: if name.is_empty() { id } else { name }.to_owned(),
            })
        })
        .collect();
    Catalog {
        models,
        ..Catalog::default()
    }
}

/// `grok models` ("* grok-4.7 (default)", "- grok-4.6"), named from its cache, with the plan its
/// settings cache names ("Free", "SuperGrok").
fn grok_catalog(listed: &str, cache: &Value, settings: &Value) -> Catalog {
    let mut catalog = Catalog::default();
    for line in listed.lines().map(str::trim) {
        let Some(rest) = line.strip_prefix("* ").or_else(|| line.strip_prefix("- ")) else {
            continue;
        };
        let (id, default) = match rest.strip_suffix(" (default)") {
            Some(id) => (id.trim(), true),
            None => (rest.trim(), false),
        };
        if id.is_empty() || id.contains(' ') {
            continue;
        }
        let name = cache["models"][id]["info"]["name"]
            .as_str()
            .filter(|n| !n.is_empty())
            .map_or_else(|| title_case(&id.replace('-', " ")), str::to_owned);
        if default {
            catalog.default = id.to_owned();
            catalog.default_name.clone_from(&name);
        }
        catalog.models.push(Model {
            id: id.to_owned(),
            name,
        });
    }
    catalog.plan = super::grok::plan_in(settings);
    catalog
}

/// Most of the user's recent opencode models offered.
const OPENCODE_RECENT: usize = 8;

/// `opencode models`, kept to what the user uses: the models they used last in opencode, OpenCode's free
/// ones, and their plan's (Zen's; Go's as OpenCode Go lists them now, `go`, when known). Never a model opencode
/// doesn't list now. The default is their own pick.
fn opencode_catalog(
    listed: &str,
    preferred: &[String],
    plan: &str,
    go: Option<&[String]>,
) -> Catalog {
    let listed = super::opencode::listed_models(listed);
    // Free: OpenCode's own free models. A plan's (ChatGPT's) lists at no cost too, but is not free.
    let label = |model: &super::opencode::Listed| {
        if model.free && model.provider == "opencode" {
            format!("{} · free", model.name)
        } else {
            model.name.clone()
        }
    };
    let mut models: Vec<Model> = Vec::new();
    let mut add = |id: &str, name: String| {
        if !models.iter().any(|m| m.id == id) {
            models.push(Model {
                id: id.to_owned(),
                name,
            });
        }
    };
    preferred
        .iter()
        .filter_map(|id| listed.iter().find(|m| m.id == *id))
        .take(OPENCODE_RECENT)
        .for_each(|m| add(&m.id, format!("Recent · {}", label(m))));
    // Then each provider the user signed in to in opencode (it lists those alone), newest version first.
    let mut theirs: Vec<_> = listed
        .iter()
        .filter(|m| !matches!(m.provider.as_str(), "opencode" | "opencode-go"))
        .collect();
    theirs.sort_by(|a, b| {
        a.provider
            .cmp(&b.provider)
            .then(version(&b.id).total_cmp(&version(&a.id)))
    });
    for m in theirs {
        add(
            &m.id,
            format!("{} · {}", provider_name(&m.provider), m.name),
        );
    }
    for m in &listed {
        if m.provider == "opencode" && m.free {
            add(&m.id, format!("Free · {}", m.name));
        } else if m.provider == "opencode" && plan == "OpenCode Zen" {
            add(&m.id, format!("Zen · {}", m.name));
        } else if m.provider == "opencode-go"
            && plan == "OpenCode Go"
            && go.is_none_or(|go| go.contains(&m.id))
        {
            add(&m.id, format!("Go · {}", m.name));
        }
    }
    let default = preferred
        .iter()
        .find_map(|id| listed.iter().find(|m| m.id == *id))
        .map(|m| (m.id.clone(), label(m)))
        .unwrap_or_default();
    Catalog {
        plan: plan.to_owned(),
        default: default.0,
        default_name: default.1,
        models,
        ..Catalog::default()
    }
}

/// The first version number in a model id: "openai/gpt-6.1-sol" is 6.1; none is 0.
fn version(id: &str) -> f64 {
    let model = id.split_once('/').map_or(id, |(_, model)| model);
    model
        .find(|c: char| c.is_ascii_digit())
        .map(|at| {
            let digits: String = model[at..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            digits.trim_end_matches('.').parse().unwrap_or(0.0)
        })
        .unwrap_or(0.0)
}

/// An opencode provider id as people write it: "openai" as "OpenAI", "my-proxy" as "My Proxy".
fn provider_name(id: &str) -> String {
    match id {
        "openai" => "OpenAI".into(),
        "anthropic" => "Anthropic".into(),
        "google" => "Google".into(),
        "openrouter" => "OpenRouter".into(),
        "github-copilot" => "GitHub Copilot".into(),
        "xai" => "xAI".into(),
        "deepseek" => "DeepSeek".into(),
        "mistral" => "Mistral".into(),
        "groq" => "Groq".into(),
        "amazon-bedrock" => "Amazon Bedrock".into(),
        "azure" => "Azure".into(),
        _ => title_case(&id.replace('-', " ")),
    }
}

/// "opus" as "Opus", "gpt_5" as "Gpt 5".
fn title_case(text: &str) -> String {
    text.split(['_', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or(String::new(), |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Claude Code's cached catalog for a Team account, as on 2026-10-26 (trimmed).
    fn claude_cached(default: &str) -> Value {
        let model = |id: &str, name: &str, section: &str, family: &str| {
            json!({"id": id, "name": name, "short_name": title_case(family), "section": section,
                "runtime": {"family": family}})
        };
        json!({"version": 2, "catalog": {"surface": "cc", "config": {"id": "cc", "models": [
            model("claude-opus-5-5", "Opus 5.5", "main", "opus"),
            model("claude-fable-5-1", "Fable 5.1", "main", "fable"),
            model("claude-sonnet-5-5", "Sonnet 5.5", "main", "sonnet"),
            model("claude-haiku-5-5", "Haiku 5.5", "main", "haiku"),
            model("claude-opus-5", "Opus 5", "overflow", "opus"),
            model("claude-sonnet-4-6", "Sonnet 4.6", "overflow", "sonnet")],
            "provider_alias_targets": {"fable": {"default": "claude-fable-5-1"},
                "haiku": {"default": "claude-haiku-5-5"}, "opus": {"default": "claude-opus-5-5"},
                "sonnet": {"default": "claude-sonnet-5-5"}}},
            "state": {"id": "cc", "model": default}}})
    }

    fn ids_and_names(catalog: &Catalog) -> Vec<(&str, &str)> {
        let models = catalog.models.iter();
        models.map(|m| (m.id.as_str(), m.name.as_str())).collect()
    }

    #[test]
    fn reads_claudes_catalog_without_fable() {
        let catalog = claude_catalog(&claude_cached("claude-opus-5-5"), "Team".into());
        assert_eq!(
            ids_and_names(&catalog),
            [
                ("opus", "Opus 5.5"),
                ("sonnet", "Sonnet 5.5"),
                ("haiku", "Haiku 5.5")
            ]
        );
        assert_eq!(
            (catalog.default.as_str(), catalog.default_name.as_str()),
            ("opus", "Opus 5.5")
        );
        assert_eq!(catalog.plan, "Team");
        // An account whose default is Fable runs with Opus.
        let fable = claude_catalog(&claude_cached("claude-fable-5-1[1m]"), String::new());
        assert_eq!(
            (fable.default.as_str(), fable.default_name.as_str()),
            ("opus", "Opus 5.5")
        );
        assert!(!fable.allows("fable") && fable.allows("sonnet") && fable.allows(""));
        // A default that is no alias's stays as it is.
        let older = claude_catalog(&claude_cached("claude-sonnet-4-6"), String::new());
        assert_eq!(older.default, "claude-sonnet-4-6");
        assert_eq!(older.default_name, "Sonnet 4.6");
        assert!(older.allows("claude-sonnet-4-6"));
    }

    #[test]
    fn reads_claudes_catalog_in_its_other_shapes() {
        // As the server sends it, and from a Claude Code that kept no alias targets.
        let cached = claude_cached("claude-haiku-5-5");
        let mut config = cached["catalog"]["config"].clone();
        config
            .as_object_mut()
            .unwrap()
            .remove("provider_alias_targets");
        let sent = json!({"model_selector_config": [config],
            "model_selector_state": [cached["catalog"]["state"]]});
        let catalog = claude_catalog(&sent, String::new());
        assert_eq!(
            ids_and_names(&catalog),
            [
                ("opus", "Opus 5.5"),
                ("sonnet", "Sonnet 5.5"),
                ("haiku", "Haiku 5.5")
            ]
        );
        assert_eq!(catalog.default, "haiku");
        // No catalog at all: the aliases by family name, Claude Code's own default.
        let none = claude_catalog(&Value::Null, "API key".into());
        assert_eq!(
            ids_and_names(&none),
            [("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]
        );
        assert_eq!(none.default, "");
    }

    #[test]
    fn names_claudes_plans_as_the_account_has_them() {
        let plan = |kind: &str, tier: &str, account: Value| {
            claude_plan_of(
                &json!({"subscriptionType": kind, "rateLimitTier": tier}),
                &account,
            )
        };
        assert_eq!(plan("pro", "default_claude_pro", Value::Null), "Pro");
        // Claude Code says "Claude Max" and "Claude Team" whatever the usage tier or seat.
        assert_eq!(plan("max", "default_claude_max_20x", Value::Null), "Max");
        let team = json!({"seatTier": "team_tier_1", "organizationType": "claude_team"});
        assert_eq!(plan("team", "default_claude_max_5x", team), "Team");
        assert_eq!(plan("enterprise", "", Value::Null), "Enterprise");
        // The account's own words win; without a sign-in's word, its organization's kind.
        let named = json!({"organization": {"plan_display_name": "Team Plus"}});
        assert_eq!(plan("team", "", named), "Team Plus");
        let only_account = json!({"organizationType": "claude_team"});
        assert_eq!(plan("", "", only_account), "Team");
        assert_eq!(plan("", "", Value::Null), "");
    }

    #[test]
    fn reads_codexs_models_and_plan() {
        let model = |id: &str, name: &str, default: bool, hidden: bool| {
            json!({"id": id, "model": id, "displayName": name, "hidden": hidden, "isDefault": default,
                "upgrade": null, "supportedReasoningEfforts": []})
        };
        let pages = [
            json!({"data": [model("gpt-6.1-sol", "GPT-6.1-Sol", true, false),
                model("gpt-6-astra", "GPT-6-Astra", false, false)], "nextCursor": "2"}),
            json!({"data": [model("gpt-5.6-luna", "GPT-5.6-Luna", false, false),
                model("codex-auto-review", "Auto review", false, true)], "nextCursor": null}),
        ];
        let account = json!({"account": {"type": "chatgpt", "planType": "prolite"}});
        let catalog = codex_catalog(&account, &pages);
        assert_eq!(catalog.plan, "Pro");
        assert_eq!(
            ids_and_names(&catalog),
            [
                ("gpt-6.1-sol", "GPT-6.1-Sol"),
                ("gpt-6-astra", "GPT-6-Astra"),
                ("gpt-5.6-luna", "GPT-5.6-Luna")
            ]
        );
        assert_eq!(
            (catalog.default.as_str(), catalog.default_name.as_str()),
            ("gpt-6.1-sol", "GPT-6.1-Sol")
        );
        let api_key = json!({"account": {"type": "apiKey"}});
        assert_eq!(codex_catalog(&api_key, &[]).plan, "API key");
        let names: Vec<String> = [
            "free", "go", "plus", "prolite", "pro", "promax", "team", "business",
        ]
        .into_iter()
        .map(codex_plan)
        .collect();
        assert_eq!(
            names,
            [
                "Free",
                "Go",
                "Plus",
                "Pro",
                "Pro (More)",
                "Pro (Max)",
                "Team",
                "Business"
            ]
        );
        assert_eq!(
            (codex_plan("enterprise"), codex_plan("edu")),
            ("Enterprise".into(), "Edu".into())
        );
    }

    #[test]
    fn reads_agys_models() {
        let listed = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
                      gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
                      claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\
                      Fetching available models...\n\
                      gpt-oss-120b-medium\t\n";
        let catalog = agy_catalog(listed);
        assert_eq!(
            ids_and_names(&catalog),
            [
                ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
                ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
                ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
                ("gpt-oss-120b-medium", "gpt-oss-120b-medium")
            ]
        );
        assert_eq!((catalog.plan.as_str(), catalog.default.as_str()), ("", ""));
    }

    #[test]
    fn tells_of_a_stand_in_once_per_pick() {
        let mut switched = BTreeMap::new();
        assert!(told(&mut switched, "codex", Some("gpt-6-astra")));
        assert!(!told(&mut switched, "codex", Some("gpt-6-astra")));
        // Another pick is news; so is the same one after it was allowed again.
        assert!(told(&mut switched, "codex", Some("gpt-6-sol")));
        assert!(!told(&mut switched, "codex", None));
        assert!(told(&mut switched, "codex", Some("gpt-6-sol")));
        assert!(told(&mut switched, "claude", Some("opus")));
    }

    #[test]
    fn looks_again_only_as_often_as_each_reason_allows() {
        let minutes = |m: u64| Some(Duration::from_secs(m * 60));
        let now = 100 * 3_600_000;
        let fresh = Catalog {
            checked_ms: now - 3_600_000,
            ..Catalog::default()
        };
        let stale = Catalog {
            checked_ms: now - 7 * 3_600_000,
            ..Catalog::default()
        };
        // Claude's own file: whenever.
        assert!(due(
            Provider::Claude,
            Why::Warm,
            Some(&fresh),
            minutes(0),
            now
        ));
        assert!(due(Provider::Codex, Why::Asked, None, None, now));
        assert!(!due(
            Provider::Codex,
            Why::Asked,
            None,
            Some(Duration::from_secs(5)),
            now
        ));
        assert!(!due(Provider::Codex, Why::Plan, None, minutes(5), now));
        assert!(due(Provider::Codex, Why::Plan, None, minutes(10), now));
        // Opening the assistant: agy's list every 6 hours, Codex's only when there is none.
        assert!(!due(Provider::Agy, Why::Warm, Some(&fresh), None, now));
        assert!(due(Provider::Agy, Why::Warm, Some(&stale), None, now));
        assert!(!due(
            Provider::Agy,
            Why::Warm,
            Some(&stale),
            minutes(30),
            now
        ));
        assert!(!due(Provider::Codex, Why::Warm, Some(&stale), None, now));
        assert!(due(Provider::Codex, Why::Warm, None, None, now));
    }

    /// The real catalogs on this computer, as Settings would get them.
    #[tokio::test]
    #[ignore = "asks the real AIs' CLIs"]
    async fn lists_the_real_models() {
        for provider in Provider::all() {
            match read(provider).await {
                Found::Catalog(catalog) => println!(
                    "{}: {}",
                    provider.id(),
                    serde_json::to_string(&catalog).unwrap()
                ),
                Found::Gone => println!("{}: not installed or signed out", provider.id()),
                Found::Failed => println!("{}: failed", provider.id()),
            }
        }
    }

    #[test]
    fn a_providers_newest_models_come_first() {
        let listed: String = [
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-6-sol",
            "gpt-6.1-sol",
            "gpt-6.1-sol-fast",
        ]
        .iter()
        .map(|id| format!("openai/{id}\n{{\n  \"name\": \"{id}\"\n}}\n"))
        .collect();
        let names: Vec<String> = opencode_catalog(&listed, &[], "Free models", None)
            .models
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(
            names,
            [
                "OpenAI · gpt-6.1-sol",
                "OpenAI · gpt-6.1-sol-fast",
                "OpenAI · gpt-6-sol",
                "OpenAI · gpt-5.4",
                "OpenAI · gpt-5.4-mini"
            ]
        );
    }

    #[test]
    fn opencode_offers_recent_your_providers_free_and_go_models_only() {
        let free = "\"cost\": {\"input\": 0, \"output\": 0}";
        let paid = "\"cost\": {\"input\": 3, \"output\": 15}";
        let listed = format!(
            "opencode/big-pickle\n{{\n  \"name\": \"Big Pickle\", {free}\n}}\n\
             opencode/claude-opus\n{{\n  \"name\": \"Claude Opus\", {paid}\n}}\n\
             opencode/mimo-free\n{{\n  \"name\": \"MiMo\", {free}\n}}\n\
             opencode-go/qwen-max\n{{\n  \"name\": \"Qwen Max\", {paid}\n}}\n\
             anthropic/claude-sonnet-5\n{{\n  \"name\": \"Claude Sonnet 5\", {paid}\n}}\n\
             openrouter/some-model\n{{\n  \"name\": \"Some Model\", {paid}\n}}\n\
             openai/gpt-6\n{{\n  \"name\": \"GPT-6\", {free}\n}}\n"
        );
        // Used last in opencode: one gone, one paid, one free.
        let preferred = [
            "openai/gone".to_owned(),
            "anthropic/claude-sonnet-5".to_owned(),
            "opencode/mimo-free".to_owned(),
        ];
        let catalog = opencode_catalog(&listed, &preferred, "OpenCode Go", None);
        assert_eq!(
            ids_and_names(&catalog),
            [
                ("anthropic/claude-sonnet-5", "Recent · Claude Sonnet 5"),
                ("opencode/mimo-free", "Recent · MiMo · free"),
                // Signed in to them in opencode; ChatGPT's at no cost is still not "free".
                ("openai/gpt-6", "OpenAI · GPT-6"),
                ("openrouter/some-model", "OpenRouter · Some Model"),
                ("opencode/big-pickle", "Free · Big Pickle"),
                ("opencode-go/qwen-max", "Go · Qwen Max"),
            ]
        );
        // The first pick it still lists; none, and opencode chooses.
        assert_eq!(
            (catalog.default.as_str(), catalog.default_name.as_str()),
            ("anthropic/claude-sonnet-5", "Claude Sonnet 5")
        );
        assert_eq!(catalog.plan, "OpenCode Go");
        assert_eq!(
            opencode_catalog(&listed, &[], "Free models", None).default,
            ""
        );
        // Nothing listed, nothing offered: never a made-up model.
        assert!(
            opencode_catalog("", &preferred, "Free models", None)
                .models
                .is_empty()
        );
        let names = |plan, go| -> Vec<String> {
            let catalog = opencode_catalog(&listed, &[], plan, go);
            catalog.models.into_iter().map(|m| m.name).collect()
        };
        // Go's own list now: a model it dropped goes, though opencode still lists it.
        let go = ["opencode-go/other".to_owned()];
        assert!(
            !names("OpenCode Go", Some(&go))
                .iter()
                .any(|n| n.starts_with("Go ·"))
        );
        // A Zen key: its paid models too; without one, only the free.
        assert!(names("OpenCode Zen", None).contains(&"Zen · Claude Opus".to_owned()));
        let free = names("Free models", None);
        assert!(
            !free
                .iter()
                .any(|n| n.starts_with("Zen ·") || n.starts_with("Go ·"))
        );
    }

    #[test]
    fn grok_lists_its_models_by_name_with_the_plan() {
        let listed = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n";
        let cache = serde_json::json!({"models": {"grok-4.7": {"info": {"id": "grok-4.7", "name": "Grok 4.7"}}}});
        let payload =
            serde_json::json!({"settings": {"subscription_tier_display": "Free"}}).to_string();
        let catalog = grok_catalog(listed, &cache, &serde_json::json!({"payload": payload}));
        assert_eq!(catalog.plan, "Free");
        assert_eq!(
            (catalog.default.as_str(), catalog.default_name.as_str()),
            ("grok-4.7", "Grok 4.7")
        );
        let names: Vec<&str> = catalog.models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["Grok 4.7", "Grok 4.6"]);
        // "Default model: grok-4.7" is not a model line.
        assert!(!catalog.allows("Default"));
    }
}
