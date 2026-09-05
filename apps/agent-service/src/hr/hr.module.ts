import { Module } from "@nestjs/common";
import { HrClient } from "./hr.client";
import { HrToolsService } from "./hr-tools.service";

@Module({
  providers: [HrClient, HrToolsService],
  exports: [HrClient, HrToolsService],
})
export class HrModule {}
