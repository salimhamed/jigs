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
workflow: by default, jigs merges an approved pull request once CI is green.

#### Requires

- A Linear app assigned to the factory in the [hub](/guide/configuration#linear-app),
  with a named installation in the ticket's workspace.
- A GitHub binding whose `installationName` names the factory's GitHub App
  [installed on its owner](/guide/configuration#github-app).
- The configured builder and reviewer harnesses, installed and authenticated.
- The [GitHub CLI](https://cli.github.com), `gh`.

The builder acts on GitHub as the factory's App, the same bot jigs posts as
through the binding's installation, which the workflow adds to the builder's
harness as `github: { installationName: worktree.installationName }` (see
[GitHub access for agents](/guide/models-and-harnesses#github-access)).
It reads discussions, posts replies and pushes fixes with `gh` and `git`, with
no token of yours. Its replies show as the bot, which is how the recipe tells
them apart from yours. No Jev model is required.

#### Run

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input linearInstallation=linear-acme --input binding=app
```

| Input | Default | What it chooses |
| --- | --- | --- |
| `ticket` | | The Linear ticket, by identifier or ID. |
| `linearInstallation` | | The [installation name](/guide/hub#installation-names) of the Linear workspace the ticket is in. |
| `binding` | | The repository to change. |
| `builder` | `builder` | The agent, by name, that builds the change. |
| `reviewer` | `reviewer` | The agent, by name, that reviews the requirements and the change. |
| `budget` | `{ reviewRounds: 3, attemptsPerUpdate: 3 }` | Implementation review rounds, and agent attempts allowed for each PR update. `attemptsPerUpdate` must be positive. |

#### Customize

Edit `workflows/linear-ticket-to-pr/` to change the builder/reviewer harnesses,
review budgets, ticket notes or the order of the phases. Every prompt is in its
`prompts.ts`. The building, reviewing, publishing and pull request maintenance
run in three jigs routines, described in
[Build a pull request workflow](/guide/build-a-workflow#build-a-pull-request-workflow);
the workflow passes them its prompts, budgets and merge policy, and writes every
note itself. The agent names above select entries defined in that source,
rather than accepting a model name at runtime.

`mergedBy` chooses who merges: `"jigs"` by default, once jigs verifies
approval, CI, mergeability and that the builder's local work is published, or
`"human"` to leave every merge to you. Pull request titles must be
conventional commit subjects; the writer gets one retry, and a second bad title
stops the run. To allow any title, delete the check in the copied workflow. `approvalCovers` chooses which commits an approving review covers:
`"latest-commit"` by default, or `"any-commit"` to let an approval carry over
later pushes. If GitHub blocks an approved, green pull request, the recipe
leaves one note on it for each commit and keeps waiting. When the pull request
needs a person, the recipe notes it on the ticket, leaves the ticket In Review
and keeps watching; only closing the pull request unmerged stops the run.
The instruction that the builder must not merge is a prompt rule, not a
restriction on its token; see
[GitHub access for agents](/guide/models-and-harnesses#github-access) and
[merging configuration](/guide/configuration#merging).

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
