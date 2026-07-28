# Browser retrain evaluation fixtures

These ten Guardian puzzle images are a fixed, representative smoke corpus for the
scheduled retrain gate. They are evaluated through the production Vite preview by
`web/scripts/evaluate-corpus.ts`; `../eval-baseline.json` records the shipped
model's expected outcome for each content hash.

Keep the set small enough for scheduled CI. Add or replace a fixture only together
with a deliberately regenerated baseline from the shipped production model.
