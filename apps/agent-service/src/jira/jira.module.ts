import { Module } from "@nestjs/common";
import { JiraMcpClient } from "./jira-mcp.client";
import { JiraToolsService } from "./jira-tools.service";

@Module({
  providers: [JiraMcpClient, JiraToolsService],
  exports: [JiraMcpClient, JiraToolsService],
})
export class JiraModule {}
