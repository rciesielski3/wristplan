import { handleCreate, handleList } from "../../../modules/workouts";
import { workoutDeps } from "../../workoutDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request): Promise<Response> => handleList(request, workoutDeps());
export const POST = (request: Request): Promise<Response> => handleCreate(request, workoutDeps());
