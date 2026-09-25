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
5. Install Pi, or point `fixer` in the workflow file at a Claude Code or Codex
   harness.
6. Carry your own edits across, and launch with the new inputs above. `jigs run`
   rejects an `--input` the workflow does not declare, so an old input such as
   `implementationModel` fails before the run starts.
