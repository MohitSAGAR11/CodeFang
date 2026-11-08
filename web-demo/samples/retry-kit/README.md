# retry-kit

Retry an async function with exponential backoff and full jitter.

```ts
import { retry } from "retry-kit";

const user = await retry(() => fetchUser(id), {
  attempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
});
```

## Options

| Option        | Default | Meaning                                   |
| ------------- | ------- | ----------------------------------------- |
| `attempts`    | `3`     | Total tries, including the first one      |
| `baseDelayMs` | `100`   | Delay before the second try               |
| `maxDelayMs`  | `5000`  | No single wait should ever exceed this    |
| `jitter`      | `true`  | Randomise each wait to avoid thundering herds |

## Known issues

- Users report waits longer than `maxDelayMs` under load.
