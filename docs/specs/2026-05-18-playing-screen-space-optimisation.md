# Spec: Playing Screen Space Optimisation

## Goal

Maximise grid real estate on the playing screen by merging the two sticky bars
into one, redesigning buttons as icon-only, moving Show candidates into Config,
replacing Edit candidates with a compact pill toggle, and stripping unnecessary
padding and card chrome in playing mode.

---

## Scope

Affects the **playing mode** layout only unless otherwise noted. The upload
screen and OCR review screen are unchanged except where explicitly stated.

---

## Section 1 — Single Header Bar

### Remove `#action-bar` as a separate element

`#action-bar` (introduced in the previous layout redesign) is removed from the
HTML. `#action-group` moves directly into `.header-inner`, inserted between the
`#load-time` span and `#new-puzzle-btn`.

The `.sticky-bars` wrapper now contains only `<header>`. The second bar
disappears; the combined bar height drops from ~108 px to ~58 px.

### Playing-mode header layout

When `#action-group` is visible the header flex row reads:

```
COACH   ↩ 💡 [Normal|Candidates] 🔍 ➕ 👁      🏠 ⚙ ? ✉
```

- `h1 COACH` — left, unchanged
- `#action-group` — inline after COACH, flex items
- `margin-left: auto` on `#new-puzzle-btn` pushes the permanent buttons right
- `.header-sub` spans and `#load-time` are **hidden in playing mode** via
  `body:has(#action-group:not([hidden])) .header-sub` and the same for
  `#load-time`. They remain visible on upload and review screens.

### "Detected Layout" heading

`#detected-layout-heading` (`<h2>`) is **hidden in playing mode** via
`body:has(#action-group:not([hidden])) #detected-layout-heading { display: none }`.
It is kept in review mode where it labels the three-column layout.

### JS changes

Every reference to `el('action-bar')` in `main.ts` is replaced with
`el('action-group')`. No other logic changes.

---

## Section 2 — Button Redesign

### Removed buttons

| Element | Removed because |
|---|---|
| `#candidates-btn` (Show/Hide candidates) | Replaced by config default |
| `#help-candidates-btn` (?) | Candidates help accessible via general Help modal |
| `#edit-candidates-btn` (Edit candidates) | Replaced by `#mode-toggle` pill |

### Icon-only buttons

All remaining action and header buttons become icon-only with a `data-tooltip`
attribute. Native `title` is not used — see Tooltip System below.

| ID | Symbol | Tooltip |
|---|---|---|
| `#undo-btn` | ↩ | Undo |
| `#hints-btn` | 💡 | Hints |
| `#inspect-cage-btn` | 🔍 | Inspect cage |
| `#virtual-cage-btn` | ➕ | Virtual cage |
| `#reveal-btn` | 👁 | Reveal |
| `#new-puzzle-btn` | 🏠 | New puzzle |
| `#help-btn` | ? | Help |
| `#config-btn` | ⚙ | Config |
| `#feedback-btn` | ✉ | Feedback |

### `(Normal|Candidates)` pill toggle

Replaces `#edit-candidates-btn`. A single `<button id="mode-toggle">` containing
two `<span>` labels:

```html
<button id="mode-toggle" class="mode-toggle" hidden
        data-tooltip="Toggle candidate edit mode">
  <span class="mode-opt">Normal</span>
  <span class="mode-opt">Candidates</span>
</button>
```

- Clicking **anywhere** on the pill toggles `candidateEditMode`.
- The active side (`Normal` when `candidateEditMode = false`, `Candidates` when
  `true`) is highlighted via a `.active` class on the button (CSS targets the
  appropriate `span` using `:not(.active)` / `.active` on the parent).
- The pill is shown whenever `showCandidates` is true at session start; hidden
  otherwise (same show/hide path as the other action buttons).
- Tooltip: "Toggle candidate edit mode".

### Button sizing

Action and header icon buttons shrink to `2.25rem × 2.25rem` with `font-size:
1.1rem` for the symbol. This applies to `.btn-secondary` buttons inside
`.header-inner` and `#action-group`.

### Tooltip system

Custom CSS tooltips via `data-tooltip` attribute:

```css
[data-tooltip] { position: relative; }
[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 200;
}
[data-tooltip]:hover::after { opacity: 1; }
```

---

## Section 3 — Candidates Config Integration

### Default behaviour

`showCandidates` is initialised to `true` when playing mode starts (previously
it defaulted to `false` until the user pressed "Show candidates").

### Config modal addition

A new row is added to `#config-modal` above the existing rule list:

```
Show candidates by default   [checkbox, default: checked]
```

Stored as `showCandidatesByDefault: boolean` in the config object alongside
`alwaysApplyRules` and `autoPlacementDelay`. Saving the modal updates the value.

### `renderPlayingMode` changes

```ts
showCandidates = config.showCandidatesByDefault ?? true;
if (showCandidates) void fetchCandidates();
el<HTMLElement>('mode-toggle').hidden = !showCandidates;
```

### Mid-session behaviour

There is no mid-session toggle for candidate visibility. To change it the user
opens Config.

---

## Section 4 — Space Recovery

All reductions applied via CSS `:has(#action-group:not([hidden]))` selectors.

| Target | Property | Before | After | Saving |
|---|---|---|---|---|
| `main` | `margin-top` / `margin-bottom` | `2rem` | `0.5rem` | ~48 px |
| `#review-panel` | `padding` | `1.5rem` | `0.5rem` | ~32 px |
| `#review-panel` | `background` | `var(--surface)` | `transparent` | visual |
| `#review-panel` | `border-color` | `var(--border)` | `transparent` | visual |
| Header | height | two bars ~108 px | one bar ~58 px | ~50 px |
| `#detected-layout-heading` | `display` | `block` | `none` | ~26 px |
| **Total** | | | | **~156 px** |

### Canvas height offset

The `:has()` canvas sizing rules currently use `100vh - 360px`. This value is
updated to `100vh - 204px` (portrait) as a starting point and tuned visually at
implementation time. The landscape rule is adjusted by the same delta.

---

## Out of Scope

- Right-click / long-press context menu (deferred, see future ideas).
- Any change to the OCR review screen layout.
- Digit pad sizing changes.
- Changes to game logic, rules, or solver.
