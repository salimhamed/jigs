export const typedocOptions = {
  blockTags: ["@example", "@remarks"],
  disableSources: true,
  entryFileName: "index",
  entryPointStrategy: "resolve",
  excludeInternal: true,
  githubPages: false,
  hideBreadcrumbs: true,
  hidePageHeader: true,
  includeVersion: true,
  inlineTags: ["@link"],
  modifierTags: ["@internal", "@packageDocumentation"],
  outputFileStrategy: "modules",
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

export default typedocOptions;
