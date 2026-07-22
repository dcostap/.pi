import { CDP, abortableSleep } from "./protocol.ts";
import { callOnObject, type Locator, withResolvedLocator } from "./locator.ts";

const DEFAULT_STYLE_PROPERTIES = [
  "display", "position", "z-index", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "row-gap", "column-gap",
  "color", "background-color", "background-image", "opacity",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-radius", "box-shadow",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-decoration-line",
  "overflow", "overflow-x", "overflow-y", "visibility", "pointer-events", "transform", "transition", "animation",
] as const;

export type InspectOptions = {
  styleProperties?: string[];
  includeAllStyles?: boolean;
  includeCssVariables?: boolean;
  includeMatchedRules?: boolean;
  includeInherited?: boolean;
};

const styleSheetStates = new Map<string, { headers: Map<string, any>; dispose: () => void }>();

export function disposeInspectorSession(sessionId: string): void {
  styleSheetStates.get(sessionId)?.dispose();
  styleSheetStates.delete(sessionId);
}

export function clearInspectorState(): void {
  for (const state of styleSheetStates.values()) state.dispose();
  styleSheetStates.clear();
}

function propertiesToRecord(properties: any[] = [], includeImplicit = false): Record<string, string> {
  const record: Record<string, string> = {};
  for (const property of properties) {
    if (!property?.name || property.disabled || (!includeImplicit && property.implicit)) continue;
    record[property.name] = property.value ?? "";
  }
  return record;
}

function extractVariableNames(values: string[]): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    for (const match of String(value || "").matchAll(/var\(\s*(--[\w-]+)/g)) names.add(match[1]);
  }
  return names;
}

function formatRule(match: any, headers: Map<string, any>) {
  const rule = match.rule || match;
  const declarations = propertiesToRecord(rule.style?.cssProperties || []);
  const styleSheetId = rule.styleSheetId || rule.style?.styleSheetId;
  const header = styleSheetId ? headers.get(styleSheetId) : undefined;
  const range = rule.selectorList?.range || rule.style?.range;
  return {
    selector: rule.selectorList?.text || "(inline)",
    origin: rule.origin || "regular",
    source: header?.sourceURL || (rule.origin === "user-agent" ? "user-agent stylesheet" : "inline stylesheet"),
    line: range?.startLine != null ? range.startLine + 1 : undefined,
    column: range?.startColumn != null ? range.startColumn + 1 : undefined,
    declarations,
    matchingSelectors: match.matchingSelectors,
  };
}

function compactRules(matches: any[] = [], headers: Map<string, any>, limit = 24, includeUserAgent = false) {
  const rules = matches
    .map((match) => formatRule(match, headers))
    .filter((rule) => includeUserAgent || rule.origin !== "user-agent");
  return rules.slice(Math.max(0, rules.length - limit));
}

export async function inspectLocator(
  cdp: CDP,
  sessionId: string,
  locator: Locator,
  options: InspectOptions,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  return withResolvedLocator(cdp, sessionId, locator, timeoutMs, signal, async (resolved) => {
    await cdp.send("DOM.enable", {}, sessionId, timeoutMs, signal);
    await cdp.send("DOM.getDocument", { depth: 1, pierce: true }, sessionId, timeoutMs, signal);
    let styleSheetState = styleSheetStates.get(sessionId);
    if (!styleSheetState) {
      const headers = new Map<string, any>();
      const dispose = cdp.onEvent("CSS.styleSheetAdded", ({ header }) => {
        if (header?.styleSheetId) headers.set(header.styleSheetId, header);
      }, sessionId);
      styleSheetState = { headers, dispose };
      styleSheetStates.set(sessionId, styleSheetState);
    }
    const headers = styleSheetState.headers;
    try {
      await cdp.send("CSS.enable", {}, sessionId, timeoutMs, signal);
      // Style-sheet-added events are delivered around CSS.enable; yield once so
      // the event queue can populate source URLs before formatting rules.
      await abortableSleep(0, signal);
      let nodeId = resolved.nodeId;
      if (!nodeId) {
        const pushed = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
          backendNodeIds: [resolved.backendNodeId],
        }, sessionId, timeoutMs, signal).catch((error) => {
          if (error?.name === "AbortError") throw error;
          return { nodeIds: [] };
        });
        nodeId = pushed.nodeIds?.[0];
      }
      if (!nodeId) {
        const requested = await cdp.send("DOM.requestNode", { objectId: resolved.objectId }, sessionId, timeoutMs, signal);
        nodeId = requested.nodeId;
      }
      if (!nodeId) throw new Error("Could not obtain a frontend DOM node id for style inspection");

      const [computedResult, matchedResult, fontsResult, boxResult] = await Promise.all([
        cdp.send("CSS.getComputedStyleForNode", { nodeId }, sessionId, timeoutMs, signal),
        options.includeMatchedRules === false
          ? Promise.resolve({})
          : cdp.send("CSS.getMatchedStylesForNode", { nodeId }, sessionId, timeoutMs, signal),
        cdp.send("CSS.getPlatformFontsForNode", { nodeId }, sessionId, timeoutMs, signal).catch((error) => {
          if (error?.name === "AbortError") throw error;
          return { fonts: [] };
        }),
        cdp.send("DOM.getBoxModel", { nodeId }, sessionId, timeoutMs, signal).catch((error) => {
          if (error?.name === "AbortError") throw error;
          return {};
        }),
      ]);

      const computedAll = propertiesToRecord(computedResult.computedStyle || [], true);
      const requestedProperties = options.includeAllStyles
        ? Object.keys(computedAll)
        : options.styleProperties?.length ? options.styleProperties : [...DEFAULT_STYLE_PROPERTIES];
      const computed: Record<string, string> = {};
      for (const name of requestedProperties) {
        if (computedAll[name] !== undefined) computed[name] = computedAll[name];
      }

      const ownMatches = matchedResult.matchedCSSRules || [];
      const inlineDeclarations = propertiesToRecord(matchedResult.inlineStyle?.cssProperties || []);
      const attributesDeclarations = propertiesToRecord(matchedResult.attributesStyle?.cssProperties || []);
      const ownRules = compactRules(ownMatches, headers, 24, !!options.includeAllStyles);
      const declarationValues = [
        ...Object.values(inlineDeclarations),
        ...Object.values(attributesDeclarations),
        ...ownRules.flatMap((rule) => Object.values(rule.declarations)),
      ];
      const variableNames = extractVariableNames(declarationValues);
      for (const rule of ownRules) {
        for (const name of Object.keys(rule.declarations)) if (name.startsWith("--")) variableNames.add(name);
      }
      const cssVariables: Record<string, string> = {};
      if (options.includeCssVariables !== false) {
        const names = options.includeAllStyles
          ? Object.keys(computedAll).filter((name) => name.startsWith("--"))
          : [...variableNames];
        for (const name of names.slice(0, 80)) {
          if (computedAll[name] !== undefined) cssVariables[name] = computedAll[name];
        }
      }

      const pseudoComputed = await callOnObject<Record<string, any>>(cdp, sessionId, resolved.objectId, `function() {
        const result = {};
        for (const pseudo of ['::before','::after','::marker','::placeholder']) {
          const style = getComputedStyle(this, pseudo);
          const content = style.content;
          if (!content || content === 'none' || content === 'normal') continue;
          result[pseudo] = {
            content, display:style.display, color:style.color, backgroundColor:style.backgroundColor,
            fontFamily:style.fontFamily, fontSize:style.fontSize, fontWeight:style.fontWeight,
            width:style.width, height:style.height, opacity:style.opacity, position:style.position,
          };
        }
        return result;
      }`, { timeoutMs, signal }).catch((error) => {
        if (error?.name === "AbortError") throw error;
        return {};
      });
      const pseudoElements = (matchedResult.pseudoElements || []).map((pseudo: any) => ({
        pseudoType: pseudo.pseudoType,
        pseudoIdentifier: pseudo.pseudoIdentifier,
        computed: pseudoComputed[`::${pseudo.pseudoType}`],
        rules: compactRules(pseudo.matches || [], headers, 12),
      }));
      const inherited = options.includeInherited
        ? (matchedResult.inherited || []).slice(0, 8).map((entry: any) => ({
            inlineStyle: propertiesToRecord(entry.inlineStyle?.cssProperties || []),
            rules: compactRules(entry.matchedCSSRules || [], headers, 10),
          }))
        : undefined;

      return {
        element: {
          tag: resolved.metadata.tag,
          id: resolved.metadata.id || undefined,
          classes: resolved.metadata.classes,
          role: resolved.metadata.role,
          name: resolved.metadata.name,
          text: resolved.metadata.text.slice(0, 240),
          attributes: resolved.metadata.attributes,
          backendNodeId: resolved.backendNodeId,
        },
        bounds: resolved.metadata.rect,
        pageBounds: resolved.metadata.pageRect,
        boxModel: boxResult.model ? {
          width: boxResult.model.width,
          height: boxResult.model.height,
          content: boxResult.model.content,
          padding: boxResult.model.padding,
          border: boxResult.model.border,
          margin: boxResult.model.margin,
        } : undefined,
        state: {
          connected: resolved.metadata.connected,
          visible: resolved.metadata.visible,
          disabled: resolved.metadata.disabled,
          editable: resolved.metadata.editable,
          focused: resolved.metadata.focused,
        },
        computed,
        cssVariables,
        fonts: (fontsResult.fonts || []).map((font: any) => ({
          family: font.familyName,
          postScriptName: font.postScriptName,
          glyphs: font.glyphCount,
          custom: font.isCustomFont,
        })),
        matched: options.includeMatchedRules === false ? undefined : {
          inline: inlineDeclarations,
          attributes: attributesDeclarations,
          rules: ownRules,
          pseudoElements,
          inherited,
        },
      };
    } finally { /* stylesheet listener intentionally persists for this target session */ }
  });
}
