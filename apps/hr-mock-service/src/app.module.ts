import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { JwtModule } from "@nestjs/jwt";
import { AuthModule } from "./auth/auth.module";
import { LeavesModule } from "./leaves/leaves.module";
import { TripsModule } from "./trips/trips.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ["../../.env", ".env"] }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>("HR_MONGO_URI") ?? config.get<string>("MONGO_URI") ?? "mongodb://localhost:27017/msb_hr",
      }),
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET") ?? "msb-hackathon-dev-secret-change-me",
        signOptions: { expiresIn: "12h" },
      }),
    }),
    AuthModule,
    LeavesModule,
    TripsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
