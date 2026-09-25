# Recipes

A recipe is a complete workflow that ships with jigs as source code. Adding one
copies its files into your factory, where they become your code: a starting
point to read, run and change. Upgrading jigs never overwrites them.

## Add a recipe

Inside your factory:

```sh
pnpm exec jigs recipe list
pnpm exec jigs recipe add linear-ticket-to-pr
```

`recipe add` reports each file it creates, and keeps any file that already
exists. It registers the workflow by adding this line to the `workflows` map in
`jigs.config.ts`:

```ts
"linear-ticket-to-pr": () => import("./workflows/linear-ticket-to-pr/linear-ticket-to-pr.ts"),
```

Then run `pnpm exec jigs up`.

## Available recipes

### linear-ticket-to-pr

Takes a Linear ticket to a merged pull request, with one agent building the
change and a second reviewing it. After publication, the builder continues in
the same agent session to handle GitHub feedback and failing checks. If the
harness loses the session, a fresh prompt supplies the ticket, diff and PR facts.
`recipe add` copies it to
`workflows/linear-ticket-to-pr/`: the workflow file, a `delivery/` directory with
its phases and prompts, its tests, and a README that says what it needs and how
to change it.

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input binding=app
```

| Input | Default | What it chooses |
| --- | --- | --- |
| `ticket` | | The Linear ticket, by identifier or ID. |
| `binding` | | The repository to change. |
| `builder` | `builder` | The agent, by name, that builds the change. |
| `reviewer` | `reviewer` | The agent, by name, that reviews it. |
| `budget` | `{ reviewRounds: 3, prTurns: 6 }` | How many implementation review rounds and PR maintenance agent turns the run may spend. |

The agent names are `builder` and `reviewer`, defined in the workflow file.
A run picks among them; it cannot name a model. To change a model, edit the
agent in the workflow file.

The recipe uses [`watchPullRequest`](/guide/build-a-workflow#wait-on-a-pull-request)
to read current PR facts after changes. The builder decides whether to change
code, answer feedback or do nothing, then returns `finished`, `pending` or
`needs-human` with a summary. It can post through its own GitHub tools without
jigs markers. Configure GitHub access for the builder's harness, such as an
authenticated `gh` command or GitHub MCP. Agents do not automatically inherit
the service's `GITHUB_TOKEN`, and configuring a GitHub App for jigs does not
configure agent tools. For a tool using a token from the service environment,
explicitly allow its variable through [`agents.env`](/guide/configuration#agents-env).
No JEV model is required.

Each invocation after publication spends one `prTurns` turn, even if the agent
decides no action is needed. Duplicate notifications with unchanged facts spend
none. The budget and stopping behavior are in the copied recipe, so you can
change them. Exhausting the budget or requesting human attention fails the run
with an explanation; unfinished work remains available.

The builder is instructed not to merge. This is a prompt rule, not a restriction
on its GitHub tools. Recipe code follows the binding's
[merge policy](/guide/configuration#merge): in human mode it waits for you;
in automatic mode it requires the builder to report finished and still checks
GitHub approval, CI and mergeability before merging. An agent's judgment does
not replace those checks. If a merge attempt is refused, the recipe fails with
the reason so you can inspect the PR before starting another run.

## Updating a recipe you already added

`recipe add` never overwrites a file you have, and leaves an existing
`workflows` entry in `jigs.config.ts` as it is. To take a newer version of
linear-ticket-to-pr:

1. Finish or cancel the runs that use it. Moving or renaming a workflow file or
   function changes its durable ID.
2. Move your copy out of `workflows/`, or delete it. Anything left under
   `workflows/` is still typechecked and tested with the factory. An older copy
   may be the file `workflows/linear-ticket-to-pr.ts`, its
   `workflows/linear-ticket-to-pr.test.ts`, and the `workflows/linear-ticket-to-pr/`
   directory; move all three.

   ```sh
   mkdir -p ../old-linear-ticket-to-pr
   mv workflows/linear-ticket-to-pr* ../old-linear-ticket-to-pr/
   ```

3. Add the recipe again: `pnpm exec jigs recipe add linear-ticket-to-pr`.
4. Check that the `workflows` entry in `jigs.config.ts` imports
   `./workflows/linear-ticket-to-pr/linear-ticket-to-pr.ts`.
5. Configure GitHub tools for the builder harness so it can read discussions,
   post replies and push fixes.
6. Carry your own edits across, and launch with the new inputs above. Replace
   old `ciFixes` and `revisionRounds` budgets with `prTurns`. `jigs run` rejects
   an `--input` the workflow does not declare, so an old input such as
   `implementationModel` fails before the run starts.
