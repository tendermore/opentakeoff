// Catalog optional-content properties and page resources must share one copier.
// Group identity is its copied reference, never its display name.
export function createLayerPreservingPageCopier(destination, pdfLib) {
  const { PDFObjectCopier, PDFPage, PDFName, PDFDict, PDFArray, PDFRef } = pdfLib;
  const name = PDFName.of;
  const sources = new Map();
  const layered = [];
  const unsupported = (detail) => { throw new Error(`Cannot preserve PDF layer configuration: ${detail}`); };
  const array = (dict, key) => dict.lookupMaybe(name(key), PDFArray)?.asArray() ?? [];
  const word = (dict, key, fallback) => dict.lookupMaybe(name(key), PDFName)?.decodeText() ?? fallback;
  const intent = (dict) => {
    const value = dict.get(name('Intent'));
    if (!value) return ['View'];
    const resolved = destination.context.lookup(value);
    const values = resolved instanceof PDFArray ? resolved.asArray() : [resolved];
    if (!values.length || values.some(v => !(v instanceof PDFName))) unsupported('non-name Intent');
    return [...new Set(values.map(v => v.decodeText()))].sort();
  };
  const keys = new Set(['Name', 'Creator', 'BaseState', 'ON', 'OFF', 'Intent', 'AS', 'Order', 'ListMode', 'RBGroups', 'Locked']);
  function describe(entry, config) {
    for (const [key] of config.entries()) if (!keys.has(key.decodeText())) unsupported(`unsupported configuration key ${key.decodeText()}`);
    const base = word(config, 'BaseState', 'ON');
    if (!['ON', 'OFF'].includes(base)) unsupported(`BaseState ${base}`);
    const refs = entry.groups.map(ref => ref.toString());
    const on = new Set(array(config, 'ON').map(ref => ref.toString()));
    const off = new Set(array(config, 'OFF').map(ref => ref.toString()));
    if ([...on, ...off].some(ref => !refs.includes(ref)) || [...on].some(ref => off.has(ref))) unsupported('invalid or conflicting ON/OFF groups');
    return { entry, config, intent: intent(config), listMode: word(config, 'ListMode', 'AllPages'),
      visible: new Map(refs.map(ref => [ref, off.has(ref) ? false : on.has(ref) ? true : base === 'ON'])) };
  }
  function mergeConfigurations(descriptions, metadata) {
    const first = descriptions[0];
    if (descriptions.some(d => JSON.stringify(d.intent) !== JSON.stringify(first.intent))) unsupported('divergent Intents');
    if (descriptions.some(d => d.listMode !== first.listMode)) unsupported('divergent ListMode');
    if (!['AllPages', 'VisiblePages'].includes(first.listMode)) unsupported(`ListMode ${first.listMode}`);
    const config = destination.context.obj({ BaseState: 'ON', Intent: first.intent.map(name), ListMode: first.listMode,
      ON: [], OFF: [], Order: [], RBGroups: [], Locked: [], AS: [] });
    for (const key of ['Name', 'Creator']) if (metadata?.get(name(key))) config.set(name(key), metadata.get(name(key)));
    for (const d of descriptions) {
      for (const ref of d.entry.groups) config.lookup(name(d.visible.get(ref.toString()) ? 'ON' : 'OFF'), PDFArray).push(ref);
      for (const key of ['Order', 'RBGroups', 'Locked', 'AS']) {
        const values = key === 'Order' && !d.config.has(name(key)) ? d.entry.groups : array(d.config, key);
        for (const item of values) config.lookup(name(key), PDFArray).push(item);
      }
    }
    return config;
  }
  function updateCatalog() {
    if (layered.length === 1) {
      // Preserve the full original D and every alternate configuration unchanged.
      destination.catalog.set(name('OCProperties'), layered[0].properties);
      return;
    }
    const defaults = layered.map(entry => {
      for (const [key] of entry.properties.entries()) if (!['OCGs', 'D', 'Configs'].includes(key.decodeText())) unsupported(`unsupported OCProperties key ${key.decodeText()}`);
      return describe(entry, entry.properties.lookup(name('D'), PDFDict));
    });
    const properties = destination.context.obj({ OCGs: [], D: mergeConfigurations(defaults), Configs: [] });
    const seen = new Set();
    for (const entry of layered) for (const ref of entry.groups) {
      if (!seen.has(ref.toString())) { properties.lookup(name('OCGs'), PDFArray).push(ref); seen.add(ref.toString()); }
    }
    for (let i = 0; i < layered.length; i++) {
      for (const config of array(layered[i].properties, 'Configs')) {
        const resolved = destination.context.lookup(config, PDFDict);
        const descriptions = defaults.slice(); descriptions[i] = describe(layered[i], resolved);
        properties.lookup(name('Configs'), PDFArray).push(mergeConfigurations(descriptions, resolved));
      }
    }
    destination.catalog.set(name('OCProperties'), properties);
  }
  return {
    copyPage(source, pageIndex) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= source.getPageCount()) throw new Error('Invalid PDF page index');
      let entry = sources.get(source);
      if (!entry) {
        if (source.isEncrypted) throw new Error('Cannot preserve layers from encrypted PDF');
        const copier = PDFObjectCopier.for(source.context, destination.context);
        entry = { copier }; sources.set(source, entry);
        const original = source.catalog.lookupMaybe(name('OCProperties'), PDFDict);
        if (original) {
          entry.properties = copier.copy(original);
          entry.groups = array(entry.properties, 'OCGs');
          if (entry.groups.some(ref => !(ref instanceof PDFRef))) unsupported('OCGs must be indirect references');
          layered.push(entry); updateCatalog();
        }
      }
      const node = entry.copier.copy(source.getPage(pageIndex).node);
      return PDFPage.of(node, destination.context.register(node), destination);
    },
  };
}
