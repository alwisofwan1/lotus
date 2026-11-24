import { redirect } from "next/navigation";

export default function AppearancePage() {
  redirect("/settings?section=general");
}
