/** Folder boundaries from AGENTS.md ("Where code goes"). */
const notTest = "\\.test\\.ts$";
const value = { dependencyTypesNot: ["type-only"] };

module.exports = {
  forbidden: [
    {
      name: "workflow-pure",
      comment: "workflow/ imports values only from workflow/, zod and the workflow SDK.",
      severity: "error",
      from: { path: "^src/workflow/" },
      to: {
        dependencyTypesNot: ["type-only", "core"],
        pathNot: ["^src/workflow/", "node_modules/(zod|workflow)/"],
      },
    },
    {
      name: "workflow-no-node",
      comment: "The workflow bundle cannot load node built-ins.",
      severity: "error",
      from: { path: "^src/workflow/" },
      to: { ...value, dependencyTypes: ["core"] },
    },
    {
      name: "steps-not-service-or-cli",
      severity: "error",
      from: { path: "^src/steps/" },
      to: { path: "^src/(service|cli)/" },
    },
    {
      name: "service-not-cli",
      severity: "error",
      from: { path: "^src/service/" },
      to: { path: "^src/cli/" },
    },
    {
      name: "providers-not-checks-steps-service-or-cli",
      comment:
        "Providers may import the Check shape from checks/check.ts, nothing else under checks/.",
      severity: "error",
      from: { path: "^src/providers/" },
      to: { path: "^src/(checks|steps|service|cli)/", pathNot: "^src/checks/check\\.ts$" },
    },
    {
      name: "config-not-steps-service-or-cli",
      severity: "error",
      from: { path: "^src/config/" },
      to: { path: "^src/(steps|service|cli)/" },
    },
    {
      name: "checks-not-service-or-cli",
      severity: "error",
      from: { path: "^src/checks/" },
      to: { path: "^src/(service|cli)/" },
    },
    {
      name: "build-not-service-or-cli",
      severity: "error",
      from: { path: "^src/build/" },
      to: { path: "^src/(service|cli)/" },
    },
    {
      name: "no-cycles",
      severity: "error",
      from: {},
      to: {
        circular: true,
        viaOnly: {
          ...value,
          // Known cycle: the drivers import their checks from checks/harnesses.ts, which looks
          // drivers up by kind. Remove this once that cycle is broken.
          pathNot: "^src/checks/harnesses\\.ts$",
        },
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: [notTest, "test-fixtures"] },
    // dependency-cruiser cannot load TypeScript 7; swc still tells type-only imports apart.
    parser: "swc",
    enhancedResolveOptions: {
      extensions: [".ts", ".js"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
