# Fixture repository instructions

- Treat every feedback comment as free-form input. Infer the expected outcome from the selected `data-feedback-id`, page context and repository code.
- Inspect `index.html`, `src/product.js` and `src/product.css` before editing the published product. The legacy checkout files only support deterministic mock tests and are not rendered.
- Make the smallest coherent change that satisfies the reported outcome.
- Add or update a regression assertion when the behavior can be checked without inventing requirements.
- Run every available package script before reporting success.
