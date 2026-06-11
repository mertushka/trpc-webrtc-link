import {
  getTRPCErrorShape,
  type AnyTRPCRouter,
  type TRPCCombinedDataTransformer,
  type TRPCDataTransformer,
  type TRPCError,
  type TRPCProcedureType,
} from '@trpc/server';

export type WebRTCTransformer = TRPCDataTransformer | TRPCCombinedDataTransformer;

const identityTransformer: TRPCDataTransformer = {
  serialize(value: unknown) {
    return value;
  },
  deserialize(value: unknown) {
    return value;
  },
};

export function normalizeTransformer(
  transformer: WebRTCTransformer | undefined,
): TRPCCombinedDataTransformer {
  if (!transformer) {
    return {
      input: identityTransformer,
      output: identityTransformer,
    };
  }
  if ('input' in transformer) {
    return transformer;
  }
  return {
    input: transformer,
    output: transformer,
  };
}

/**
 * This is the only module that reads tRPC's router definition internals.
 * tRPC's own WebSocket adapter uses the same `_def._config` access to preserve
 * the configured transformer and error formatter.
 */
export function getRouterRuntimeConfig<TRouter extends AnyTRPCRouter>(router: TRouter) {
  return router._def._config;
}

export function getRouterTransformer<TRouter extends AnyTRPCRouter>(
  router: TRouter,
): TRPCCombinedDataTransformer {
  return getRouterRuntimeConfig(router).transformer;
}

export function shapeRouterError<TRouter extends AnyTRPCRouter>(options: {
  router: TRouter;
  error: TRPCError;
  type: TRPCProcedureType | 'unknown';
  path: string | undefined;
  input: unknown;
  ctx: TRouter['_def']['_config']['$types']['ctx'] | undefined;
}): unknown {
  const config = getRouterRuntimeConfig(options.router);
  const shape = getTRPCErrorShape({
    config,
    error: options.error,
    type: options.type,
    path: options.path,
    input: options.input,
    ctx: options.ctx,
  });
  return config.transformer.output.serialize(shape);
}
