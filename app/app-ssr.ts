import App from "./app.ts";
import environment from "./config.ts";

export function createSsrApp(): App {
  return App.create({ ...environment.APP, autoboot: false });
}
