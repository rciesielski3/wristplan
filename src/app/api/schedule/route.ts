import { handleSchedule, handleScheduleList } from "../../../modules/calendar";
import { scheduleDeps } from "../../scheduleDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request): Promise<Response> =>
  handleScheduleList(request, scheduleDeps());
export const POST = (request: Request): Promise<Response> =>
  handleSchedule(request, scheduleDeps());
