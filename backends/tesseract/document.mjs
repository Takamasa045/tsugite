export function applyTesseractDocument(document, documentSchema, input) {
  const rootSchema = resolveSchemaNode(documentSchema, documentSchema);
  const rootProperties = rootSchema.properties ?? {};
  if (!Object.hasOwn(rootProperties, "duration") || typeof document.duration !== "number") {
    throw new Error("installed Tesseract document schema does not expose document.duration; refusing to guess the duration field");
  }

  const candidates = findCompositionCandidates(document, documentSchema);
  if (candidates.length !== 1) {
    throw new Error(`installed Tesseract document schema must expose exactly one composition with an id and layer list; found ${candidates.length}`);
  }
  const composition = candidates[0];
  const compositionProperties = composition.schema.properties ?? {};
  if (composition.value.layers.length !== 0) throw new Error("tsrct project create must produce an empty composition before editing");
  if (typeof composition.value.id !== "string" || composition.value.id.length === 0) {
    throw new Error("installed Tesseract composition has no stable string id");
  }
  if (!Object.hasOwn(compositionProperties, "layers")) {
    throw new Error("installed Tesseract schema does not define composition layers");
  }

  const dimensionTarget = findDimensionTarget(document, documentSchema, composition);
  dimensionTarget.width = input.width;
  dimensionTarget.height = input.height;
  document.duration = input.durationSeconds;
  composition.value.layers = input.layers;
  return { document, compositionId: composition.value.id };
}

/** Use a complete inline native document after checking the runtime's essential contract. */
export function applyTesseractNativeDocument(documentSchema, authoredDocument, input) {
  if (!authoredDocument || typeof authoredDocument !== "object" || Array.isArray(authoredDocument)) {
    throw new Error("native_edit.document must be a full Tesseract document object");
  }
  const rootSchema = resolveSchemaNode(documentSchema, documentSchema);
  if (rootSchema.type !== "object" || !Array.isArray(rootSchema.required) || !rootSchema.properties) {
    throw new Error("installed Tesseract document schema has an unsupported shape; refusing native document authoring");
  }
  for (const key of rootSchema.required) {
    if (typeof key !== "string" || !Object.hasOwn(authoredDocument, key)) {
      throw new Error(`native_edit.document is missing required Tesseract document field '${key}'`);
    }
  }
  if (typeof authoredDocument.duration !== "number" || !Number.isFinite(authoredDocument.duration) ||
      Math.abs(authoredDocument.duration - input.durationSeconds) > 0.001) {
    throw new Error("native_edit.document.duration must match the reviewed manifest duration");
  }

  const document = JSON.parse(JSON.stringify(authoredDocument));
  const candidates = findCompositionCandidates(document, documentSchema);
  if (candidates.length !== 1) {
    throw new Error(`native_edit.document must contain exactly one composition with an id and layer list; found ${candidates.length}`);
  }
  const composition = candidates[0];
  if (typeof composition.value.id !== "string" || composition.value.id.length === 0) {
    throw new Error("native_edit.document composition has no stable string id");
  }
  const dimensions = findDimensionTarget(document, documentSchema, composition);
  if (dimensions.width !== input.width || dimensions.height !== input.height) {
    throw new Error(`native_edit.document canvas ${dimensions.width}x${dimensions.height} must match the reviewed ${input.width}x${input.height} canvas`);
  }
  return { document, compositionId: composition.value.id };
}

function findCompositionCandidates(document, documentSchema) {
  const candidates = [];
  const visited = new Set();
  const visit = (value, schemaNode) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const schema = resolveSchemaNode(schemaNode, documentSchema);
    const properties = schema.properties ?? {};
    if (!Array.isArray(value) && typeof value.id === "string" && Array.isArray(value.layers) && Object.hasOwn(properties, "layers")) {
      candidates.push({ value, schema });
    }
    if (Array.isArray(value)) {
      const itemSchema = resolveSchemaNode(schema.items ?? {}, documentSchema);
      for (const item of value) visit(item, itemSchema);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) visit(child, childSchema);
    }
  };
  visit(document, documentSchema);
  return candidates;
}

function findDimensionTarget(document, documentSchema, composition) {
  const compProperties = composition.schema.properties ?? {};
  const rootProperties = resolveSchemaNode(documentSchema, documentSchema).properties ?? {};
  const dimensionsSchema = resolveSchemaNode(rootProperties.dimensions, documentSchema);
  const dimensionsProperties = dimensionsSchema.properties ?? {};
  if (Object.hasOwn(rootProperties, "dimensions") &&
      Object.hasOwn(dimensionsProperties, "width") && Object.hasOwn(dimensionsProperties, "height") &&
      document.dimensions && typeof document.dimensions === "object" &&
      typeof document.dimensions.width === "number" && typeof document.dimensions.height === "number") {
    return document.dimensions;
  }
  if (Object.hasOwn(compProperties, "width") && Object.hasOwn(compProperties, "height") &&
      typeof composition.value.width === "number" && typeof composition.value.height === "number") {
    return composition.value;
  }
  if (Object.hasOwn(rootProperties, "width") && Object.hasOwn(rootProperties, "height") &&
      typeof document.width === "number" && typeof document.height === "number") {
    return document;
  }
  throw new Error("installed Tesseract document schema does not identify numeric width and height fields on its composition, document, or document.dimensions");
}

function resolveSchemaNode(node, root, depth = 0) {
  if (!node || typeof node !== "object" || depth > 24) return {};
  let resolved = {};
  if (typeof node.$ref === "string") resolved = resolveSchemaNode(resolveJsonPointer(root, node.$ref), root, depth + 1);
  const properties = { ...(resolved.properties ?? {}), ...(node.properties ?? {}) };
  const combined = { ...resolved, ...node, properties };
  delete combined.$ref;
  if (Array.isArray(node.allOf)) {
    for (const child of node.allOf) {
      const part = resolveSchemaNode(child, root, depth + 1);
      Object.assign(combined, part);
      combined.properties = { ...(combined.properties ?? {}), ...(part.properties ?? {}) };
    }
  }
  return combined;
}

function resolveJsonPointer(root, pointer) {
  if (!pointer.startsWith("#/")) throw new Error(`unsupported schema reference '${pointer}'`);
  const parts = pointer.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value = root;
  for (const part of parts) value = value?.[part];
  return value;
}
