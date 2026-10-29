import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { SegmentsService } from '../segments/segments.service';
import { ChannelClientService } from '../channel-client/channel-client.service';
import { buildPagination, paginatedResult } from '../../common/helpers/pagination.helper';

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segmentsService: SegmentsService,
    private readonly channelClientService: ChannelClientService,
  ) {}

  async create(createCampaignDto: CreateCampaignDto) {
    await this.segmentsService.findOne(createCampaignDto.segmentId);

    return this.prisma.campaign.create({
      data: {
        name: createCampaignDto.name,
        objective: createCampaignDto.objective,
        segmentId: createCampaignDto.segmentId,
        messageTemplate: createCampaignDto.messageTemplate,
        channel: createCampaignDto.channel,
        status: 'draft',
      },
    });
  }

  async findAll(query?: { page?: string; limit?: string; search?: string }) {
    const pagination = buildPagination(query);

    const where: any = {};
    if (query?.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.campaign.findMany({
        skip: pagination.skip,
        take: pagination.limit,
        where,
        include: {
          segment: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return paginatedResult(data, total, pagination);
  }

  async findOne(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        segment: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return campaign;
  }

  async approve(id: string) {
    const campaign = await this.findOne(id);
    if (campaign.status !== 'draft') {
      throw new BadRequestException(`Campaign status is already ${campaign.status}, cannot approve`);
    }
    return this.prisma.campaign.update({
      where: { id },
      data: { status: 'approved' },
    });
  }

  async send(id: string) {
    const campaign = await this.findOne(id);

    const isRetry = 
      campaign.status === 'partial' ||
      campaign.status === 'failed';
    
    if(campaign.status !== 'approved' && !isRetry) {
      throw new BadRequestException(`Capgaign status is ${campaign.status}. 
        Campaigns must be approved before sending.`);
    }

    let targetCustomers;
    if(isRetry) {
      const prevousCommunications = await this.prisma.communication.findMany({
        where: {campaignId: id},
        include: {customer: true},
      });

      if(prevousCommunications?.length > 0) {
        targetCustomers = prevousCommunications.map((communcation) => communcation.customer,);
      }else {
        const preview = await this.segmentsService.preview(
          campaign.segmentId,
        );
        targetCustomers = preview.customers;
      }
    }else {
      const preview = await this.segmentsService.preview(campaign.segmentId,);
      targetCustomers = preview.customers;
    }

    if(targetCustomers.length === 0) {
      throw new BadRequestException(
        `Target segment has 0 matching customers. Cannot send campaign`,
      );
    }

    const claimed = await this.prisma.campaign.updateMany({
      where: {
        id, 
        status: campaign.status,
      },
      data: {
        status: 'sending',
        sentAt: null,
      },

    });


    if(claimed.count === 0) {
      throw new BadRequestException(
        `Campaign is already begin send or its status has changed. `,
      );
    }

    const successfulStatuses = [
      'send',
      'delivered',
      'opened',
      'read',
      'clicked',
      'purchased',
    ];

    const outcomes: Array<'sent' | 'failed' | 'skipped' > = [];

    const batchSize = 10;

    for(let i = 0; i < targetCustomers.length; i+= batchSize) {
      const batch  = targetCustomers.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (customer) => {
          let communicationId: string | undefined;

          try {
            const messageRendered = campaign.messageTemplate
            .replace(/\{\{name\}\}/g, customer.name)
            .replace(/\{\{email\}\}/g, customer.email);


            const existing = await this.prisma.communication.findUnique({
              where : {
                campaignId_customerId: {
                  campaignId: id,
                  customerId: customer.id,
                },
              },
            });

            if(existing && successfulStatuses.includes(existing.status)){
              return 'skipped' as const;
            }

            let communcation;

            if(existing) {
              communicationId = existing.id;

              communcation = await this.prisma.communication.update({
                where: {id: existing.id},
                data: {
                  status: 'pending',
                  messageRendered,
                  failureReason: null,
                  sentAt: null,
                  deliveredAt: null,
                  openedAt: null,
                  readAt: null,
                  clickedAt: null,
                  purchasedAt: null,
                },
              });
            }else {
              communcation = await this.prisma.communication.create({
                data: {
                  campaignId: id,
                  customerId: customer.id,
                  channel: campaign.channel,
                  messageRendered,
                  status: 'pending',
                },
              });

              communicationId = communcation.id;
            }

            await this.channelClientService.send({
              communicationId: communcation.id,
              campaignId: id,
              customer: {
                id: customer.id,
                name: customer.name,
                phone: customer.phone,
                email: customer.email,
              },
              channel: campaign.channel,
              message: messageRendered,
            });

            await this.prisma.communication.updateMany({
              where: {
                id: communcation.id,
                status: 'pending',
              },
              data: {
                status: 'sent',
                sentAt: new Date(),
                failureReason: null,
              },
            });

            return 'sent' as const;
          }catch(error) {
            const reason = error instanceof Error ? error.message : String(error);

            if(communicationId) {
              await this.prisma.communication.updateMany({
                where: {
                  id: communicationId,
                  status: 'pending',
                },
                data : {
                  status: 'failed',
                  failureReason: reason,
                },
              })
              .catch(() => undefined);
            }

            return 'failed' as const;
          }
        }),
      );

      for(const result of  results) {
        if(result.status === 'fulfilled') {
          outcomes.push(result.value);
        }else {
          outcomes.push('failed');
        }
      }
    }


    const successfullCount = outcomes.filter(
      (result) => result === 'sent' || result === 'skipped',
    ).length;

    const failedCount = outcomes.filter (
      (result) => result === 'failed',
    ).length;

    const finalStatus = failedCount === 0 ? 'sent' : successfullCount > 0 ? 'partial' : 'failed';


    const updatedCampaign = await this.prisma.campaign.update({
      where: {id},
      data : {
        status : finalStatus,
        sentAt: finalStatus === 'sent' ? new Date() : null,
      },
    });


    return {
      campaign : updatedCampaign,
      audienceSize: targetCustomers.length,
      sentCount: outcomes.filter(
        (result) => result === 'sent',
       ).length,
       skippedCount: outcomes.filter(
        (result) => result === 'skipped',
       ).length,
       failedCount,
    };
  }
}
