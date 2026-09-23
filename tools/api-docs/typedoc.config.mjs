export const sharedOptions = {
  blockTags: ["@example", "@group", "@module", "@remarks"],
  disableSources: true,
  entryPointStrategy: "resolve",
  excludeInternal: true,
  githubPages: false,
  includeVersion: true,
  inlineTags: ["@link"],
  modifierTags: ["@internal", "@packageDocumentation"],
  readme: "none",
  treatValidationWarningsAsErrors: true,
  treatWarningsAsErrors: true,
  validation: {
    invalidLink: true,
    invalidPath: true,
    notDocumented: false,
    notExported: false,
    rewrittenLink: true,
    unusedMergeModuleWith: true,
  },
};

export const typedocOptions = {
  ...sharedOptions,
  entryFileName: "index",
  hideBreadcrumbs: true,
  hidePageHeader: true,
  router: "module",
};

export default typedocOptions;

// Site-only: tables and code-block signatures scan well in a browser, while the
// npm pages under docs/api keep the default layout that reads well as plain text.
export const siteOptions = {
  classPropertiesFormat: "table",
  enumMembersFormat: "table",
  interfacePropertiesFormat: "table",
  parametersFormat: "table",
  sortEntryPoints: false,
  tableColumnSettings: {
    hideDefaults: false,
    hideInherited: true,
    hideModifiers: true,
    hideOverrides: true,
    hideSources: true,
    leftAlignHeaders: true,
  },
  typeAliasPropertiesFormat: "table",
  typeDeclarationFormat: "table",
  useCodeBlocks: true,
};
