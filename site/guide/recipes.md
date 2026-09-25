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
change and a second reviewing it. `recipe add` copies it to
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
| `budget` | `{ reviewRounds: 3, ciFixes: 3, revisionRounds: 3 }` | How many review rounds, CI fixes and revision rounds the run may spend. |

The agent names are `builder`, `reviewer` and `fixer`, defined in the workflow
file. A run picks among them; it cannot name a model. To change a model, edit
the agent in the workflow file.

## Updating a recipe you already added

`recipe add` never overwrites a file you have. To take a newer version of a
recipe, move your copy aside, add the recipe again, and carry your changes
across:

```sh
git mv workflows/linear-ticket-to-pr workflows/linear-ticket-to-pr.old
pnpm exec jigs recipe add linear-ticket-to-pr
```

`recipe add` also leaves an existing `workflows` entry in `jigs.config.ts` as it
is, so check that it imports the path shown above.

Moving or renaming a workflow file or function changes its durable ID, so
finish or cancel the runs that use the old one first.
