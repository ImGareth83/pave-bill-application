import { Service } from "encore.dev/service";

// Encore will consider this directory and all its subdirectories as part of the "backend" service.
// https://encore.dev/docs/ts/primitives/services

// The backend service implements billing APIs.
export default new Service("backend");
