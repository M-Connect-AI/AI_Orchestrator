import { Injectable } from "@nestjs/common";
import { formatPolicyChunks, PolicyChunk, retrievePolicy } from "@msb/policy-docs";

@Injectable()
export class PolicyRagService {
  retrieve(query: string, k = 3): PolicyChunk[] {
    return retrievePolicy(query, k);
  }

  format(chunks: PolicyChunk[]) {
    return formatPolicyChunks(chunks);
  }
}
