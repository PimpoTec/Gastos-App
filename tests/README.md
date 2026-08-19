# Tests

Smoke tests con Playwright que corren contra `app.html` con un mock de
Supabase (no tocan la base real). Cubren que la navegación principal
funciona y que se puede cargar un gasto de punta a punta — no reemplazan
pruebas específicas de cada feature, pero avisan si un cambio rompe lo
básico.

## Correr los tests

```bash
npm install
npx playwright install chromium   # solo la primera vez
npm test
```
