export const sharedOptions = {
  blockTags: ["@example", "@remarks"],
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
  outputFileStrategy: "modules",
};

export default typedocOptions;
