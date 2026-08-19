// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8934',
    trace: 'retain-on-failure',
    // En este entorno el navegador ya viene instalado en una ruta fija (no en la
    // que espera por defecto la versión de @playwright/test del package.json).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: 'python3 -m http.server 8934',
    url: 'http://localhost:8934/app.html',
    reuseExistingServer: !process.env.CI,
  },
});
