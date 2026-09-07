import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Thread, ThreadSchema } from "./thread.schema";
import { ThreadService } from "./thread.service";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { AuthModule } from "../auth/auth.module";
import { HrModule } from "../hr/hr.module";
import { LlmClient } from "../agent/llm.client";
import { InputGuardService } from "../agent/input-guard.service";
import { ToolRunnerService } from "../agent/tool-runner.service";
import { ToolAgentService } from "../agent/tool-agent.service";
import { EmbeddingClient } from "../policy/embedding.client";
import { PolicyRagService } from "../policy/policy-rag.service";
import { QdrantPolicyClient } from "../policy/qdrant.client";

@Module({
  imports: [
    AuthModule,
    HrModule,
    MongooseModule.forFeature([{ name: Thread.name, schema: ThreadSchema }]),
  ],
  providers: [
    ThreadService,
    ChatService,
    LlmClient,
    InputGuardService,
    ToolRunnerService,
    ToolAgentService,
    EmbeddingClient,
    QdrantPolicyClient,
    PolicyRagService,
  ],
  controllers: [ChatController],
})
export class ChatModule {}
