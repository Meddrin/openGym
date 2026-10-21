# The AI Coach

An optional **assistant** inside openGym: a chat that answers questions about training, technique
and food, looks things up in your own data to do it, and — when you ask, or when a change clearly
follows — **proposes edits** to your plan, your logged workouts, your body weight, your exercise
notes and own exercises, your settings and your coach profile. It runs on your own server under your
own provider account, off until an admin turns it on.

It never edits anything itself. A proposal arrives as a card with a before and an after for each
change and the assistant's reason; you apply it with one tap, and undo it with one tap.

> Before v1.5 the Coach was a set of fixed jobs that returned one JSON document (build a plan,
> review the last weeks, debrief a workout). Those jobs, their prompts, the repair round, the
> scheduled review and the mandatory intake are gone; the assistant replaces them. The intake
> answers remain as optional context it can read and propose edits to (**Coach menu → Edit my coach
> profile**).

---

## Which providers can run it

The assistant is a **tool loop**: the model asks to look something up, the server answers from one
profile's data, and the loop ends when the model answers in prose. Only two providers run one.

| Provider | What runs | Credential | Image | Assistant |
| --- | --- | --- | --- | --- |
| **Claude (Anthropic)** | the Claude Agent SDK, inside the container, with an in-process tool server | a `claude setup-token`, or an API key | `coach` | yes |
| **Anthropic API** | plain HTTPS to `api.anthropic.com`, the tool loop over the Messages API | an API key | default | yes |
| OpenAI API, Google Gemini, OpenAI-compatible endpoint | plain HTTPS | an API key (optional for an endpoint) | default | **no** |
| Codex (OpenAI) | the Codex CLI, inside the container | Codex's own device sign-in | `coach` | **no** |

An instance on a provider that cannot run the assistant is not broken, it is plain about it: the
admin card says so on the provider step, `GET /api/config` carries `coach.assistant: false`, the
Coach screen shows which provider it needs instead of a chat, and a message is refused with 409
`tools` before anything is spent. The connection test still works for all of them.

The HTTPS providers spawn nothing: a job is one `fetch` from the api process (or a few, for a tool
loop), so there is no child process to drop privileges on and nothing to install: **the Anthropic
API works on the image every instance already has.** The `coach` image, the unprivileged `coach`
user and the `./coach-auth` mount described further down exist for the runtime-backed providers.

## Turning it on

Nothing here is an environment variable or a restart — the whole point of the admin card is that
enabling the Coach is a decision you make in the app.

### Where people find it

The Coach has one door: the **Coach** entry in the **Plan** menu (the button in the top-right
corner of the Plan header), which opens the chat. Up to v1.3.9 it was a card at the top of Plan. The phone app also has
**Settings → AI Coach**, where the phone chooses between your server's Coach and a key of its
own (see [On the phone](#on-the-phone)).

The entry appears only when all of these hold:

- **The master switch is on.** That is **Set up the Coach** on the admin card
  (**Settings → Account → Admin dashboard**, the **AI Coach** card), and afterwards the toggle at the top
  of the same card. A provider that is connected and passes **Test the Coach** is not enough
  on its own: with the switch off, the server tells every app there is no Coach, and the card
  reads *Off right now — nobody sees it anywhere in the app*.
- **The provider is connected**, so the admin card reads **ready**: a credential saved, or for
  a compatible endpoint without a key, an endpoint.
- **The person is signed in.** A guest in the browser has no Coach, because a job reads a
  profile's synced data.
- **`COACH_DISABLED` is not set** in the server's environment (see
  [Off is really off](#off-is-really-off)).

The admin's own app shows the change as soon as the admin card saves it. Everyone else's app
picks it up the next time it is opened or reloaded.

### With an API key (the Anthropic API; the others for a connection test)

**1. Get a key** from the provider's own console.

**2. Connect it.** In the app: **Settings → Account → Admin dashboard**, the **AI Coach** card.

- Toggle the card on.
- Pick the provider chip. Only **Anthropic API** (and Claude, below) can run the assistant; the
  others can be filed and tested, and the card says plainly that they cannot chat.
- For a compatible endpoint, enter the **Endpoint** — `http://` or `https://`, no username or
  password in it, no query string. The host is written into the job log so you can see where
  jobs went. Paste the base the way the provider documents it: a bare host
  (`http://ollama.lan:11434`) gets `/v1` added, and a base that already carries its version
  (`https://openrouter.ai/api/v1`, Zhipu's `…/paas/v4`, Gemini's `…/v1beta/openai`) is used
  as it is. A base whose API has no version at all (Open WebUI's `…/openai` mount) works too:
  when `{base}/v1/…` answers 404, the app tries `{base}/…` and remembers which one answered.
- A gateway that demands extra headers gets them under **Extra headers**: one `Name: value`
  per line (e.g. opencode Go's `x-opencode-session`), sent with the list, test and job
  calls. `Authorization` and `Content-Type` are refused there — auth framing always wins.
- **Use an API key** → paste it. It is encrypted into `./data/coach.json` and is never shown
  again.
- **List models** asks the provider what it serves and turns the model field into a picker. Each
  provider has a starting default (it is in `api/coach/core/providers.js`, and it is a starting
  point, not a pin — names go stale, the list does not).
- **Test the Coach** — a real round trip with no user data anywhere near it.

For an OpenAI-compatible endpoint the card also takes an **Endpoint** and optional **Extra
headers**, as before; they only matter for the connection test, because that provider cannot run
the assistant.

The card says two things worth reading: which account is being spent, and — for these providers —
that jobs run no child process at all, so the privilege-drop line reads as not applicable rather
than as a problem.

**3. Use it.** Each person opens **Plan → Coach**. The first thing they see is the consent screen,
which lists the categories of data the assistant can reach, generated from the same module the
tools are bound to, and says that nothing is sent up front. Agreeing opens the chat:

- Ask anything. The assistant answers in prose (markdown, rendered safely: no raw HTML ever
  reaches the page) in the language you write in, and shows how long it has been thinking.
- Ask it to change something. It looks the ids up, checks the change against your data, and
  answers with a card: each change with before and after and a one-sentence reason. **Apply**
  runs the whole set on your device as ordinary local edits (so the sync carries them);
  **Dismiss** throws it away; **Undo** puts back exactly what it touched.
- The thread lives on the server, in the profile's own Coach record, so a reply that arrives while
  the app is closed is there when it opens, and every device reads the same conversation. It keeps
  the last 60 messages and is bounded in bytes; older proposals shrink to a summary of what they
  were and what became of them. Forgetting the Coach deletes it.
- Users cannot switch the Coach off themselves — only the admin can, from the card above.

A key, a model and the account binding described below belong to the provider they were entered
for. Switching chips does not clear them: the Anthropic key is still there when you come back from
trying another provider, and each chip shows a mark when it holds one.

#### The output ceiling

Every answer has a ceiling on how much the provider may write, set on **Settings → Admin dashboard
→ AI Coach → Advanced → Max output tokens** (16000 by default). A "thinking" model counts its
hidden reasoning against that same ceiling, so an answer can be cut off even when it is short. If
a message fails with *"the answer was cut off at the output limit"*, raise it; keep it within the
model's own output limit.

### With a runtime in the container (Claude Agent SDK, Codex CLI)

**1. Build the image that has an AI runtime in it.** The default image deliberately has none:

```bash
API_TARGET=coach docker compose up -d --build api
```

`--build` matters. With a prebuilt `image:` also set, compose would otherwise pull the default.

**2. Get a credential.** On a trusted machine where you already use Claude Code:

```bash
claude setup-token
```

Complete its normal browser sign-in and copy the token it prints. openGym never opens or handles
that flow — it only ever receives the finished token. (Claude also accepts an Anthropic API key
here, under the same chip; the setup token is the route for a Claude subscription.)

**3. Connect it.** In the app: **Settings → Account → Admin dashboard**, the **AI Coach** card.

- Toggle the card on.
- Pick the **Claude (Anthropic)** provider chip.
- **Add CLI token** → paste the token, and optionally label whose account it is (that label is
  what both the admin card and each user's Coach screen show when they name the account).
- **Test the Coach** — a real round trip through the provider with no user data anywhere near it.
  It reports the runtime version on success, and the provider's own error on failure.

The card also states two things worth reading before anyone uses it: whether jobs actually run
unprivileged, and which account is being spent.

**4. Use it** — as above. This is the provider the assistant was built around: the Agent SDK runs
the tool loop, with only the openGym tools available to it (see
[What the model is allowed to do](#what-the-model-is-allowed-to-do)).

> **On a multi-profile instance, read [Whose account pays](#whose-account-pays) first.** An API
> key is shared by every profile under the daily limits. A *personal* credential — a Claude Code
> setup token — binds to the first profile that spends it and **every other profile is refused**,
> by design: that is the right behaviour when one person's personal subscription is behind it.

### Comparing with others on the instance

Off unless the admin turns it on (**Settings → Account → Admin dashboard**, the **AI Coach** card →
**Advanced → Let people compare with each other**), and then still off for each person until they
opt in themselves (**Compare with others here → Include me** in the Coach chat). The trade is
symmetric: a profile that does not share sees nothing.

What is shown is coarse on purpose — a median across everyone sharing for sessions per week and
for the best estimated 1RM per exercise, next to the person's own number, plus where they rank.
An exercise appears only when three or more people train it, and nothing appears at all until
three people share. Never a name, a body weight, a date or a single session. The medians reach the
person's own screen and nothing else: the assistant is not given them, and has no tool that reads
another profile. The opt-in lives in the server's own per-profile record, not in synced state, so
a stale device cannot flip it back on; switching it off removes the person from the next
computation immediately.

## Whose account pays

This is the first thing to settle, because it decides what the rest of the feature is allowed
to be. The Coach spends a real provider account, and there are two shapes:

| Mode | Credential | For |
| --- | --- | --- |
| **instance** | one account, stored encrypted in `coach.json` | the single-profile instance most people run |
| **profile** | one account per profile, in its own `coach-auth-<uid>.json` | anything with more than one profile |

In instance mode it depends on what kind of credential was pasted:

- **An API key** (Anthropic, OpenAI, Gemini, an OpenAI-compatible endpoint) is shared by every
  profile on the instance. It is metered, issued for exactly this kind of use, and the daily
  limits in the admin card are what bound what it can spend. This is the shape a household or a
  small gym wants.
- **A personal credential** — a Claude Code setup token or an OAuth login — **binds to the first
  profile that spends it**. Any other profile is refused:

> This instance is configured with a single shared account. Ask your admin to enable
> per-profile sign-in.

No job runs. That is a refusal, not a warning, on purpose — a warning moves the decision onto
whoever clicks past it, and the decision is about spending somebody else's personal
subscription. It is the same posture the payload allowlist takes.

**The instance owner is responsible for their provider's terms.** openGym does not interpret
them on a self-hoster's behalf; it makes the shape that doesn't need the interpretation
available, and refuses the shape that does.

**Switching to profile mode.** In the admin card (**Advanced → Whose account pays**) pick **Each
profile connects its own**, or call `POST /api/admin/coach/auth-mode` with `{ "mode": "profile" }`.
The provider is still the admin's choice; each person then connects their own account of a kind
that provider takes (a Claude Code setup token or an API key for Claude, an API key for the HTTPS
providers) under **Your account** in the Coach settings, or with `POST /api/coach/credential`
(`DELETE` to disconnect, `POST /api/coach/credential/test` for a round trip on their own
credential). A profile with no credential of its own is refused with a message pointing there.
There is no fallback to the instance credential, and no setting that lets one profile use
another's. Switching modes deletes nothing: the instance credential and its binding stay filed for
switching back, and the daily limits apply per profile in both modes.

A profile credential lives in its own file, `0600`, never in `state-<uid>.json` — profile state
syncs across devices and travels in the user's JSON export, and a credential that rides along in
a backup is the same class of mistake as a token inside the directory the README tells you to
archive.

## What actually leaves your server

Nothing is sent up front. The assistant gets the conversation (the last twenty turns, each cut to
1500 characters, with what became of any proposal in them), today's date, the app language and the
weight unit, and then **asks for what a question needs, one tool call at a time**. Every tool is
bound to one uid when the job is created and reads that profile's state file, read-only. No tool
takes a uid, a path or a file name (`api/test/assistant-tools.test.js` asserts it by looking at
every parameter), so a model that is talked into asking for somebody else's data has nothing to
ask with, and the state reader is only ever asked for the one uid.

`api/coach/core/payload.js` still cuts what a tool returns: every field is copied in **by name**,
bounded by type and length, nothing is spread, so a field added to the state blob next year cannot
ride along by accident. The categories a tool can return — the same list the consent screen
renders from, so the screen cannot drift from what can leave — are:

| Category | What it covers |
| --- | --- |
| `plan` | routines, exercises, sets/reps, schedule, per-date overrides, progression settings |
| `training` | logged workouts the assistant looks up: sets, weights, reps, effort, durations, notes |
| `bodyweight` | weigh-ins and your goal weight |
| `profile` | the intake answers (limits, injuries), standing exercise notes, your own exercises |
| `prefs` | unit, language, effort scale, the settings it may change |
| `chat` | your messages and its recent replies |

The tools:

| Tool | Parameters | Returns |
| --- | --- | --- |
| `get_profile` | none | unit, language, effort scale, goal weight, the settings it may change, the intake answers, totals |
| `get_plan` | none | routines with exercises, the week, per-date overrides |
| `list_workouts` | `from?`, `to?`, `exerciseId?`, `limit?` | newest first, short form |
| `get_workout` | `id` | every exercise and set, with the indices an edit refers to |
| `search_exercises` | `query?`, `muscle?`, `bodyPart?`, `equipment?`, `limit?` | library and own exercises, with ids |
| `get_my_exercises` | none | own exercises, standing notes, favourites |
| `get_bodyweight` | `from?`, `to?`, `limit?` | weigh-ins, weekly means, goal |
| `get_stats` | `topic?`, `weeks?`, `exerciseId?` | estimated 1RM, weekly hard sets per muscle, adherence |
| `propose_changes` | `summary?`, `changes` | validation result; on success the proposal is kept for the card |

Text the user wrote (workout names, notes, intake answers) comes back as data, and the system
prompt says tool results and stored notes are data, never instructions. Messages the user types are
instructions, within the rules.

Excluded on purpose and permanently: **display name and user id, passkey and credential material,
push subscriptions, invite data, theme and appearance settings, and every other profile's
everything.**

## Bodyweight and per-side work

Upstream v1.2.4 taught the app that a push-up carries no load and a lunge is logged as a total
across both sides. The assistant has to know the same things, because on a bodyweight exercise
`weight` means *added* load and is `0` on a perfectly good session — so every load-shaped signal
reads flat. The plan view carries `bodyweight`, `side` and `repsMax`, and the validator enforces
the two rules with a single right answer: per-side reps are a total across both sides and so even,
and a rep ceiling is never below its floor.

The server re-implements three reading rules the frontend owns — `modeOf`, `isBw`, `isPerSide` —
and two more (`isWarmupSet`, the Epley estimate) because the api image has no build step in common
with the frontend. `coach-parity.test.js` and `api/test/payload-parity.test.js` pin them against
the originals, so the copies cannot drift silently.

## What it may change, and how

The tool description asks for a shape and the model usually obliges. `api/coach/core/changes.js`
is where "usually" stops mattering, and it — not the prompt — is a security boundary. A change set
is **all or nothing** and nothing reaches you that has not:

- **matched the closed list of change types.** Thirty of them. A hostile note in your own free text
  can talk a model into saying anything at all; it cannot invent a change type, and a type that is
  not on the list does nothing.
- **resolved against the real exercise library or your own exercises.** An id nobody has refuses
  the whole set, with the id named and `search_exercises` suggested, rather than being quietly
  dropped into a plan that renders blank the first time you train it.
- **hit something that exists.** Every target names a routine, workout, weigh-in or exercise that
  is really there, and `before` is read off your data, never taken from the model.
- **carried sane numbers.** Reps, weights, durations, dates and settings have ranges; a logged
  set needs something in it; a workout needs one completed working set; a date is not in the future.
- **made sense as a whole,** applying cleanly to a throwaway copy of your state: two changes to the
  same workout, or one that uses an exercise another deletes, are refused.
- **cited its reason.** A change with no `why` is refused.

The model sees the validation errors in the same job and fixes its proposal (a second successful
call replaces the first); a model that cannot gets a plain answer and no card.

| Kind | What |
| --- | --- |
| plan (18) | `add-exercise`, `remove-exercise`, `swap-exercise`, `sets`, `reps`, `repsMin`, `repsMax`, `sec`, `cardio`, `reorder`, `superset`, `routine-prog`, `exercise-prog`, `inc`, `add-routine`, `remove-routine`, `rename-routine`, `week` |
| calendar | `dayplan`: one date's override (a routine, rest, or back to the schedule) |
| logged workouts | `workout-add`, `workout-edit` (name, note, date, exercises and sets, by index), `workout-delete` |
| body weight | `bodyweight-set`, `bodyweight-delete` |
| exercises | `exnote-set` (the standing note), `custom-ex-add`, `custom-ex-edit`, `custom-ex-delete` |
| settings | `setting` for `restSec`, `restPauseSec`, `sound`, `keepAwake`, `timedSetOvertime`, `effort`, `weekStart`, `wdec`, `targetW`, `oneRmFormula`, `speedUnit`, `equipFilterOn` |
| intake | `profile-set` |

Not possible, by construction: the weight unit (switching it converts every logged weight, a data
migration with its own confirmation in Settings, not something to flip inside an undoable set),
anything about accounts, passwords, credentials, invites, other profiles or the server itself.

**Applying happens on the client**, not the server (`frontend/src/lib/coach-changes.js`). Before
it runs, the proposal is validated again with the very same module, against your state as it is
now; if it does not validate to exactly what was shown (a workout deleted on another device, a
weigh-in edited since) the card says your data has changed, Apply is switched off and nothing is
written. Apply then runs inside the store's update, whose draft is discarded if anything throws, so
a failure part-way leaves the state exactly as it was. It is ordinary local editing: it works
offline, syncs like everything else, and the store stamps workouts, weigh-ins, deletions and
settings the way every other edit is stamped.

Every apply first takes an undo snapshot of every top-level key it is about to touch. Small keys
(routines, week, settings, notes) are kept whole; the lists that can be large (workouts, weigh-ins,
own exercises) are kept per record, so editing one workout does not copy the history into your
synced state. Undo puts the snapshot back (restored workouts and weigh-ins get a newer stamp than
the edit they undo, so another device keeps the undo), including the personal-record badges the
change may have granted or revoked. Only the newest apply can be undone; the last three snapshots
are kept.

A job is given five minutes by default, which is generous for any hosted API: `COACH_JOB_TIMEOUT_MS`
in `.env` raises the budget (never below one minute).

## Isolation

This section is about the two providers that run a runtime inside the container. The HTTPS
providers run nothing: a job is one `fetch` from the api process, the adapter says so
(`spawns: false`), and the gate below asks the adapter rather than assuming — so an instance on
a host with no `coach` user still gets the Coach through an API key, and is only refused the
runtime-backed providers. The admin card reports "this provider runs no child process" in the
place it would otherwise report the drop.

For Claude Agent SDK and Codex jobs run as an unprivileged `coach` user that cannot read the files holding secrets, with an
environment built from nothing rather than filtered from the parent — no `RP_ID`, no
`ADMIN_UIDS`, no VAPID material.

That privilege drop **fails closed**: on Linux, if it cannot be performed, no job is enqueued
and the admin card says so. It used to fail open — it only engaged when the server ran as root,
so adding an ordinary `USER` line to the Dockerfile, for unrelated hardening reasons, would have
quietly left the runtime inheriting the server's uid. A control that switches itself off during
somebody else's refactor is one you find out about late.

The secrets are locked file by file — `secret`, `db.json`, `coach.json` at `0600` — rather than
by sealing `./data` with a blanket `0700`. The directory is a host bind mount and the container
runs as root, so sealing it lands on the host as root-owned and unreadable, and anything else
the owner runs against their own data directory gets `EACCES`.

## You only carry the AI runtime if you ask for it

The HTTPS providers need none, and run on the `default` image below — so as of this release
the `coach` target is only for an owner who specifically wants the Claude Agent SDK or the
Codex CLI. Everything else in this section is about those two.

`api/Dockerfile` builds two targets from one file:

- **`default`** — what every instance has always had. `npm ci --omit=optional` skips the Agent
  SDK and its platform runtime entirely, so an owner who never wanted the Coach ships none of it.
  Around 158 MB.
- **`coach`** — the same image plus `@anthropic-ai/claude-agent-sdk`. Around 455 MB.

```
docker build --target coach ./api          # or:
API_TARGET=coach docker compose up --build api
```

The SDK sits in `optionalDependencies`, and its runtime ships as a per-platform package — this
base is Alpine, so the lockfile resolves `linux-x64-musl` / `linux-arm64-musl`. That resolution
is the sort of thing that only fails on somebody else's machine, so CI builds **and runs** both
targets: the default one has to boot and serve `/api/config` with the SDK genuinely unimportable,
and the coach one has to report a runnable SDK through the same `check()` the admin card renders.

An absent runtime is an ordinary state, not a crash: the adapter imports the SDK lazily, `check()`
says it is missing, `isConnected()` goes false, and `/api/config` carries no `coach` key at all.

Both targets create the unprivileged `coach` user. That is not a Claude-specific detail — the
privilege drop fails closed, so without that user *every* job is refused, including the fixture
provider that exists precisely so the loop can be walked before an account is connected.

## What the model is allowed to do

The Claude provider runs through the Agent SDK rather than a hand-rolled CLI call, because the SDK
exposes the switches that matter and brings its own matching runtime. The assistant's tools are an
**in-process SDK MCP server** (`createSdkMcpServer` + `tool()`), built per job from the toolset
above and living in the api process: the unprivileged runtime reaches them over the SDK's control
channel and has no other way to anything. Everything else the SDK could hand a model is switched
off, each by a documented option:

| Option | Effect |
| --- | --- |
| `tools: []` | Disables **all** built-in tools — no Read, no Bash, no Grep, no WebFetch. The model has no filesystem or network tool at all, however it is prompted. |
| `disallowedTools` | The built-ins by name, a second lock on the same door. |
| `allowedTools` | Exactly the nine `mcp__opengym__*` tools, nothing else pre-approved. |
| `permissionMode: 'dontAsk'` | Anything not pre-approved is denied; nothing ever prompts (there is nobody to prompt). |
| `settingSources: []` | No user/project/local settings file is loaded, so nothing on the host can widen the lines above afterwards. |
| `skills: []` | Same, for skills. |
| `strictMcpConfig` | No MCP server can arrive from ambient configuration; ours is the only one. |
| `persistSession: false` | Nothing is written to disk for the next job to find. |
| `maxTurns: 12` | A handful of lookups, a proposal, a fix and the answer; not an open-ended loop. |

They are exported from `api/coach/adapters/claude.js` and asserted by value in `adapters.test.js`
(the options object a job really passes to the SDK is built by one pure function, so the test
reads the real thing), so widening one is a red build rather than a quiet capability grant.

The credential reaches the model process as an environment variable and by no other route. The
job environment is built from nothing rather than filtered, and the SDK's `env` option *replaces*
the child environment rather than extending it — so `RP_ID`, `ADMIN_UIDS` and the VAPID keys
cannot reach it by inheritance even by accident. The Anthropic API provider runs the same loop with
the same tools over HTTP, with the same turn budget, one overall timeout and no tools but ours.

## Where a credential lives

Everything a provider owns — its credential, its model, and in instance mode the profile its
credential bound to — is stored **per provider** in `coach.json`, so switching providers never
throws a key away. An instance upgraded from an earlier build, where the file held one flat
credential and one model for whichever provider was selected, has them lifted onto that
provider the first time the new server reads the file. This is one-way: a downgrade will not
read the maps back, and costs one paste of the key.

Three shapes, because the providers work differently:

- **The HTTPS providers** hold an API key, encrypted with the instance secret into
  `coach.json`, and hand it to the request as a header — `x-api-key`, `Authorization: Bearer`
  or `x-goog-api-key`, never a query parameter, so it stays out of proxy logs and error
  messages. It is inside `./data`, so it *is* in the documented backup; without `./data/secret`
  the blob is undecryptable, which is the same protection every other credential there has.

- **Claude** takes its credential on the environment, so nothing is written to disk beyond the
  encrypted blob in `coach.json` — it reaches the model process as `CLAUDE_CODE_OAUTH_TOKEN` (or
  `ANTHROPIC_API_KEY`) and by no other route.
- **Codex** keeps a refreshable sign-in cache of its own, so it needs somewhere durable to write.
  That is `./coach-auth`, mounted at `/coach-auth`, owned by the `coach` user, mode `0700`.

`./coach-auth` is a **sibling of `./data`, never a folder inside it**, and that placement is the
whole point. §5 of `docs/SELF_HOSTING.md` tells owners to back up with `tar czf … data/`.
Anything under `./data` is therefore in every backup archive people are instructed to produce —
and unlike workout history, a refresh token keeps working after that archive is copied to a
laptop or a cloud drive. Keeping the cache outside `./data` is what lets the backup instructions
stay true about what they capture.

Per-profile credentials follow the same rule for the same reason: they live in
`coach-auth-<uid>.json` at mode `0600`, never in the synced state blob, so they cannot ride along
in a device sync or in a user's own JSON export.

## On the phone

The App-Store build has no server of its own, so the Coach there is a choice made in
**Settings → AI Coach**, and until it is made nothing AI-related is loaded at all:

- **Use my self-hosted openGym.** Pair the phone with your instance (the same pairing flow as
  syncing — **Settings → Account → Pair the mobile app** on the site, then the address and code on the
  phone). A paired phone is an ordinary profile: the assistant runs on your server with whatever
  provider the admin configured, under the rules above, and nothing on the phone changes.
- **Bring my own API key.** The phone calls the **Anthropic API** directly with a key you paste, and
  runs the same nine tools and the same tool loop as the server, in the app, over the state it
  already holds. The conversation is kept in the phone's own device file (not in the synced state,
  so it cannot ride along in a backup, an export or a sync). The key is kept in the platform's
  secure storage — Keychain on iOS, the Keystore-backed store on Android — and never in the app's
  state. You pay: the screen says which host each request goes to and what can leave the device
  before you choose, and a local daily cap stands in for the one an admin would have set. The other
  providers can still be filed here, but they cannot run the assistant, and the Coach screen says
  so rather than offering a chat.

  A compatible endpoint has to be **`https://`** here. Android does not let apps send
  unencrypted `http://` traffic, and the setup screen says so as soon as such an address is typed.

## Off is really off

`COACH_DISABLED=1` forces the Coach off everywhere regardless of what is stored — the fleet
operator's kill switch. With the Coach off, `/api/config` carries no `coach` key at all, so no
Coach UI exists anywhere in the client.

## Health

The Coach programs training; it does not practise medicine. It is told never to diagnose, to
stay conservative when someone describes pain rather than soreness, and to recommend a
professional. **It is not a doctor or a physiotherapist. If something hurts, ask one.**
