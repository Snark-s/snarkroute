# Example Plugin Env Echo

This plugin node demonstrates the SnarkRoute executor contract.

It receives only environment variables listed in `permissions.env`. It writes a JSON output through `assets.writeJson`.

Manual test:

1. Set `SNARKROUTE_EXAMPLE_TOKEN=demo`.
2. Import `manifest.json` with `executor.ts` in the package folder.
3. Add `Example Plugin Env Echo` to a route.
4. Run the route.
5. Confirm the output lists only `SNARKROUTE_EXAMPLE_TOKEN` as an allowed env key.
