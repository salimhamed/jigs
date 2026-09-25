# Recipes

A recipe is a complete workflow that ships with jigs as source code. Adding one
copies its files into your factory, where they become your code.

**Recipes are copied templates, not managed dependencies.** Your factory owns
the code, you can change it freely, and upgrading jigs never overwrites it.

## Add a recipe

```sh
pnpm exec jigs recipe list
pnpm exec jigs recipe add linear-ticket-to-pr
pnpm exec jigs up
```

Adding a recipe also registers it in `jigs.config.ts` when the workflows map
can be edited automatically. The command reports any manual action needed and
keeps existing files and registrations.

## Available recipes

### linear-ticket-to-pr

#### What it does

Reads a Linear ticket, asks a builder agent to implement the change, then asks
a reviewer agent to review it. It publishes a pull request and lets the builder
continue responding to feedback and CI. Merging follows the policy in the copied
workflow: by default, a person merges.

#### Requires

- A [Linear identity](/guide/configuration#linear-identity).
- A GitHub binding and [GitHub identity](/guide/configuration#github-identity).
- The configured builder and reviewer harnesses, installed and authenticated.
- GitHub tools for the builder, such as authenticated `gh` or GitHub MCP, so
  it can read discussions, post replies and push fixes.

GitHub access for jigs does not configure GitHub access for the coding agent.
Agents do not automatically inherit `GITHUB_TOKEN`. Allow a token variable
through [`agents.env`](/guide/configuration#agents-env) if the agent's tools need
it. No Jev model is required.

#### Run

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input binding=app
```

| Input | Default | What it chooses |
| --- | --- | --- |
| `ticket` | | The Linear ticket, by identifier or ID. |
| `binding` | | The repository to change. |
| `builder` | `builder` | The agent, by name, that builds the change. |
| `reviewer` | `reviewer` | The agent, by name, that reviews it. |
| `budget` | `{ reviewRounds: 3, attemptsPerUpdate: 3 }` | Implementation review rounds, and agent attempts allowed for each PR update. `attemptsPerUpdate` must be positive. |

#### Customize

Edit `workflows/linear-ticket-to-pr/` to change the builder/reviewer harnesses,
prompts, review budgets or delivery behavior. The agent names above select
entries defined in that source, rather than accepting a model name at runtime.

`mergedBy` chooses who merges: `"human"` by default, or `"jigs"` after the
builder reports finished and jigs verifies approval, CI and mergeability.
The instruction that the builder must not merge is a prompt rule, not a
restriction on its GitHub tools. See [merging configuration](/guide/configuration#merging).

The copied README and source document review attempts, PR updates and recovery
in detail. [Waiting and external events](/guide/waiting-and-events) explains
the watcher the recipe uses.

## Updating a copied recipe

`recipe add` never overwrites a recipe already in the factory:

1. Finish or cancel active runs using that workflow.
2. Preserve your current copy outside the active `workflows/` path.
3. Add the current recipe again with `pnpm exec jigs recipe add linear-ticket-to-pr`.
4. Compare the copies and carry your customizations forward intentionally.
   Check that `jigs.config.ts` imports the new copy.
5. Run `pnpm exec jigs up`, then typecheck and test the factory.

Moving workflow files can change their [durable identities](/guide/concepts#why-jigs-generates-code-in-your-factory).
