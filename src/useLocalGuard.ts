import { useEffect, useRef } from "react";
import { registerLocalGuard } from "./local-lifecycle";

export function useLocalGuard(issue: string) {
  const current = useRef(issue);
  current.current = issue;
  useEffect(() => registerLocalGuard(() => current.current), []);
}
