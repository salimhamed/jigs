// The Linear issue calls a factory wraps as its own steps. A re-export rather
// than a move: providers/linear.ts keeps the rest of its surface for checks/
// and the other steps, which share its GraphQL helper.

export {
  type CreateIssueInProjectInput,
  createComment,
  createIssueInProject,
  findIssueInProject,
  type LinearIssueMatch,
} from "../../providers/linear.ts";
