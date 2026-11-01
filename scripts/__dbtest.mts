import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const count = await prisma.feedback.count();
console.log("classic path OK, feedback rows:", count);
await prisma.$disconnect();
