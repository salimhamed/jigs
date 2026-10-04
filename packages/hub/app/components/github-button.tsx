import { Form } from "react-router";
import { button } from "./ui.ts";

/** Posts to the current route's action, which starts GitHub sign-in. */
export function GitHubButton({ children }: { children: string }) {
  return (
    <Form method="post">
      <button type="submit" className={button}>
        {children}
      </button>
    </Form>
  );
}
