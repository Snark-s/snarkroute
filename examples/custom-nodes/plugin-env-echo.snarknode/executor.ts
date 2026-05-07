export async function runNode(context) {
  const { inputs, params, env, assets, logger } = context;
  logger.info("Running env echo example.");
  const result = {
    label: params.label ?? "env-check",
    message: inputs.message ?? null,
    allowedEnvKeys: Object.keys(env),
    hasExampleToken: Boolean(env.SNARKROUTE_EXAMPLE_TOKEN)
  };
  const asset = await assets.writeJson("env-echo-result.json", result);
  return {
    outputs: {
      result,
      file: asset
    },
    metadata: {
      example: true
    }
  };
}
