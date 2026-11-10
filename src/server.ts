import "dotenv/config";
import { createApp } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";

let env;
try {
  env = loadEnv();
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const app = createApp(env);

app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT}`);
});
