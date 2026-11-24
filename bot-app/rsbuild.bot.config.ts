// Build override: emit the app for hosting under /bot/ instead of the root.
import baseConfig from './rsbuild.config';

export default (env: any, utils: any) => {
  const base = typeof baseConfig === 'function' ? (baseConfig as any)(env, utils) : baseConfig;
  const botBasePath = (process.env.BOT_BASE_PATH || '/bot').replace(/\/+$/, '') || '/bot';
  return {
    ...base,
    source: {
      ...base.source,
      define: {
        ...(base.source?.define ?? {}),
        'process.env.NEXT_PUBLIC_BASE_PATH': JSON.stringify(botBasePath),
      },
    },
    output: {
      ...base.output,
      assetPrefix: `${botBasePath}/`,
      distPath: { ...(base.output?.distPath ?? {}), root: 'out/bot' },
    },
  };
};
