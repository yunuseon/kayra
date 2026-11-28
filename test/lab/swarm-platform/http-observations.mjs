// Previous releases may finish accepted requests while draining after readiness turns false.
// A candidate must be ready before it receives application traffic.
export const prematureCandidateRequests = (requests, release) => requests.filter((request) => request.release === release && request.ready !== true);
