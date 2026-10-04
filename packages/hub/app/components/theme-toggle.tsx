import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

const themes = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Theme"
        className="rounded-md p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <Sun className="size-4 dark:hidden" />
        <Moon className="hidden size-4 dark:block" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="min-w-32 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow-md dark:border-zinc-800 dark:bg-zinc-900"
        >
          {themes.map(({ value, label, Icon }) => (
            <DropdownMenu.Item
              key={value}
              onSelect={() => setTheme(value)}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800"
            >
              <Icon className="size-4" />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
