import Link from "next/link";
import { LoginForm } from "@/components/auth/LoginForm";

export default function LoginPage() {
  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Sign in</h2>
      </header>
      <div className="p-4">
        <LoginForm />
        <p className="text-muted mt-4 text-xs">
          No account?{" "}
          <Link href="/signup" className="text-accent hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </section>
  );
}
