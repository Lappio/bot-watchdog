import { useState } from "react";
import { ThemeProvider as Provider, useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <Provider
      attribute="class"
      storageKey="bw_theme"
      defaultTheme="system"
      enableSystem
    >
      {children}
    </Provider>
  );
}
export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Choose theme">
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {[
          ["light", Sun],
          ["dark", Moon],
          ["system", Monitor],
        ].map(([name, Icon]) => (
          <DropdownMenuItem
            key={String(name)}
            onClick={() => setTheme(String(name))}
          >
            <Icon />
            {String(name)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function LoginCard({
  onLogin,
  error,
}: {
  onLogin: (token: string) => void;
  error?: string;
}) {
  const [token, setToken] = useState("");
  return (
    <main className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">bot-watchdog</CardTitle>
          <CardDescription>
            Sign in to monitor your scheduled bots.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) onLogin(token.trim());
            }}
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="token">Paste ADMIN_TOKEN</Label>
              <Input
                id="token"
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <Button className="w-full" type="submit">
              Sign in
            </Button>
            <p className="text-xs text-muted-foreground">
              Your token is stored in this browser and sent with API requests.
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
