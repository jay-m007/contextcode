import { login } from "@/lib/auth";

export function LoginForm() {
  const submit = async (form: FormData) => {
    await login(String(form.get("email")), String(form.get("password")));
  };
  return <form action={submit}><input name="email" /><input name="password" type="password" /></form>;
}
