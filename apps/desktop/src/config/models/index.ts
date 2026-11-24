/**
 * Public API for the global model catalog. Import from here, not from
 * the inner files, so that we can refactor internals freely.
 */

export {
  MODEL_CATALOG,
  MODEL_DEFAULTS,
  type ModelAvailability,
  type ModelCostTier,
  type ModelEntry,
  type ModelProvider,
  type ModelVariant,
} from "./catalog";

export {
  getCodeChatModelOptions,
  getPaneTitleModelOptions,
  getPlannerModelsByProvider,
  type CodeChatModelOption as CatalogCodeChatModelOption,
  type PaneTitleModelOption,
  type PlannerCatalogModel,
} from "./presets";
