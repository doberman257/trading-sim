export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-base flex min-h-screen items-center justify-center p-3">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
