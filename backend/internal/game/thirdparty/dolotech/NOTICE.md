# dolotech/doudizhu attribution

Source: https://github.com/dolotech/doudizhu

Pinned commit: `2e77a90de5c0531232a31c07a6d6d765fb04d927`.

License: Apache License 2.0 (full text in LICENSE).

`constan.go`, `analyse_cards.go`, and `follow.go` are copied from `src/algorithm`
at that commit. `card.go` retains the upstream card-value conversion, removing
the unavailable `utils` import and unused shuffle/ownership functions.

The game layer uses the packed rank histogram and comparison rules. It validates
unique physical card IDs and classifies combinations independently, so historical
upstream classifier edge cases cannot authorize illegal plays. In particular it
does not reuse upstream VerifyCards, which accepts duplicate requested cards.

Formatting may differ after gofmt. No upstream NOTICE file was present.
