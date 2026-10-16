# Blackjack

A single-page blackjack game written in plain HTML, CSS and JavaScript. There's no build step, so you can deploy the `web/` folder as-is to any static host.

## Run locally

```sh
cd web
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
```

You can also open `index.html` directly in a browser.

## Tests

```sh
node web/tests.js
```

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup |
| `style.css` | Table, CSS-drawn cards and chips, animations, responsive layout |
| `engine.js` | Pure game logic: shoe, hand scoring, round state machine, dealer AI, basic strategy (no DOM; also loads in Node) |
| `game.js` | UI: rendering and animation, input and keyboard shortcuts, Web Audio sounds, localStorage |
| `tests.js` | Console tests for scoring, dealer rules, payouts, split, double, insurance, reshuffle and strategy |

## Rules

- 6-deck shoe, reshuffled once fewer than 25% of the cards remain (the red line on the shoe meter).
- The dealer hits 16 or less and stands on all 17s. The dealer peeks for blackjack when showing an Ace or a ten-value card.
- Blackjack pays 3:2. Insurance pays 2:1 (it's offered as "even money" when you have blackjack).
- You can double on any first two cards, including after a split.
- One split is allowed. Split aces get one card each, and an ace plus a ten after a split counts as 21, not blackjack.
