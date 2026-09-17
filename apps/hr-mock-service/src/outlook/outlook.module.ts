import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  OutlookConnection,
  OutlookConnectionSchema,
} from "../schemas/outlook-connection.schema";
import { AuthModule } from "../auth/auth.module";
import { OutlookService } from "./outlook.service";
import { OutlookController } from "./outlook.controller";

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: OutlookConnection.name, schema: OutlookConnectionSchema },
    ]),
  ],
  providers: [OutlookService],
  controllers: [OutlookController],
  exports: [OutlookService],
})
export class OutlookModule {}
