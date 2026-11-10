// Augments Express's Request with the verified JWT claims set by the auth middleware.
import type { LoginGuard } from "../auth/loginGuard.js";
import type { DefenseState } from "../config/defense.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { sub: string; exp: number };
    }
    interface Locals {
      defense: DefenseState;
      loginGuard: LoginGuard;
    }
  }
}

export {};
