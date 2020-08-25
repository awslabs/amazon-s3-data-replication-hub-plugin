import threading
import logging
import hashlib
import concurrent
import base64
import time

from migration_lib.client import DownloadClient, UploadClient


logger = logging.getLogger(__name__)

# Process one job
def job_processor(upload_id, index_list, partnumber_list, job, src_client: DownloadClient, des_client: UploadClient,
                  max_thread, chunk_size, max_retry, job_timeout, verify_md5_twice, include_version):
    # 线程生成器，配合thread pool给出每个线程的对应关系，便于设置超时控制
    def thread_gen(woker_thread, pool,
                   stop_signal, partnumber, total, md5list, partnumber_list, complete_list):
        for partStartIndex in index_list:
            # start to upload part
            if partnumber not in partnumber_list:
                dryrun = False  # dryrun 是为了沿用现有的流程做出完成列表，方便后面计算 MD5
            else:
                dryrun = True
            th = pool.submit(woker_thread,
                             stop_signal=stop_signal,
                             partnumber=partnumber,
                             partStartIndex=partStartIndex,
                             total=total,
                             md5list=md5list,
                             dryrun=dryrun,
                             complete_list=complete_list
                             )
            partnumber += 1
            yield th

    # download part from src. s3 and upload to dest. s3
    def woker_thread(*, stop_signal, partnumber, partStartIndex, total, md5list, dryrun, complete_list):
        if stop_signal.is_set():
            return "TIMEOUT"
        Src_bucket = src_client.bucket_name
        Src_key = job['Key']
        Des_bucket = des_client.bucket_name
        Des_key = job['Key']
        versionId = job['Version']
        getBody, chunkdata_md5 = b'', b''  # init

        # start downloading
        if verify_md5_twice or not dryrun:  # 如果 verify_md5_twice 则无论是否已有上传过都重新下载，作为校验整个文件用
            if include_version:
                logger.info(f"----->Downloading {chunk_size} Bytes {Src_bucket}/{Src_key} - {partnumber}/{total}"
                            f" - versionId: {versionId}")
            else:
                logger.info(
                    f"----->Downloading {chunk_size} Bytes {Src_bucket}/{Src_key} - {partnumber}/{total}")
            retryTime = 0

            # 正常工作情况下出现 stop_signal 需要退出 Thread
            while retryTime <= max_retry and not stop_signal.is_set():
                retryTime += 1
                try:
                    if include_version:  # 按VersionId获取Object
                        getBody, chunkdata_md5 = src_client.get_object(
                            Src_key, partStartIndex, chunk_size, versionId)
                    else:
                        getBody, chunkdata_md5 = src_client.get_object(
                            Src_key, partStartIndex, chunk_size)
                    md5list[partnumber - 1] = chunkdata_md5
                    break  # 完成下载，不用重试

                # TODO update this.
                # except ClientError as err:
                #     if err.response['Error']['Code'] in ['NoSuchKey', 'AccessDenied']:
                #         # 没这个ID，文件已经删除，或者无权限访问
                #         logger.error(
                #             f"ClientError: Fail to access {Src_bucket}/{Src_key} - ERR: {str(err)}.")
                #         stop_signal.set()
                #         return "QUIT"
                #     logger.warning(f"ClientError: Fail to download {Src_bucket}/{Src_key} - ERR: {str(err)}. "
                #                    f"Retry part: {partnumber} - Attempts: {retryTime}")
                #     if retryTime >= max_retry:  # 超过次数退出
                #         logger.error(f"ClientError: Quit for Max Download retries: {retryTime} - "
                #                      f"{Src_bucket}/{Src_key}")
                #         stop_signal.set()
                #         return "TIMEOUT"  # 退出Thread
                #     else:
                #         time.sleep(5 * retryTime)
                #         continue
                    # 递增延迟，返回重试
                except Exception as e:
                    logger.warning(f"Fail to download {Src_bucket}/{Src_key} - ERR: {str(e)}. "
                                   f"Retry part: {partnumber} - Attempts: {retryTime}")
                    if retryTime >= max_retry:  # 超过次数退出
                        logger.error(
                            f"Quit for Max Download retries: {retryTime} - {Src_bucket}/{Src_key}")
                        stop_signal.set()
                        return "TIMEOUT"  # 退出Thread
                    else:
                        time.sleep(5 * retryTime)
                        continue
        # 上传文件
        if not dryrun:  # 这里就不用考虑 verify_md5_twice 了，
            retryTime = 0
            while retryTime <= max_retry and not stop_signal.is_set():
                retryTime += 1
                try:
                    logger.info(
                        f'----->Uploading {len(getBody)} Bytes {Des_bucket}/{Des_key} - {partnumber}/{total}')
                    # des_client.upload_part(
                    #     Body=getBody,
                    #     Bucket=Des_bucket,
                    #     Key=Des_key,
                    #     PartNumber=partnumber,
                    #     upload_id=upload_id,
                    #     ContentMD5=base64.b64encode(
                    #         chunkdata_md5.digest()).decode('utf-8')
                    # )

                    des_client.upload_part(
                        Des_key, getBody, chunkdata_md5, partnumber, upload_id)
                    # 请求已经带上md5，如果s3校验是错的就Exception
                    break

                # TODO update this.
                # except ClientError as err:
                #     if err.response['Error']['Code'] == 'NoSuchUpload':
                #         # 没这个ID，则是别人已经完成这个Job了。
                #         logger.warning(f'ClientError: Fail to upload part - might be duplicated job:'
                #                        f' {Des_bucket}/{Des_key}, {str(err)}')
                #         stop_signal.set()
                #         return "QUIT"
                #     logger.warning(f"ClientError: Fail to upload part - {Des_bucket}/{Des_key} -  {str(err)}, "
                #                    f"retry part: {partnumber} Attempts: {retryTime}")
                #     if retryTime >= max_retry:
                #         logger.error(
                #             f"ClientError: Quit for Max Upload retries: {retryTime} - {Des_bucket}/{Des_key}")
                #         # 改为跳下一个文件
                #         stop_signal.set()
                #         return "TIMEOUT"
                #     else:
                #         time.sleep(5 * retryTime)  # 递增延迟重试
                #         continue
                except Exception as e:
                    logger.warning(f"Fail to upload part - {Des_bucket}/{Des_key} -  {str(e)}, "
                                   f"retry part: {partnumber} Attempts: {retryTime}")
                    if retryTime >= max_retry:
                        logger.error(
                            f"Quit for Max Upload retries: {retryTime} - {Des_bucket}/{Des_key}")
                        # 改为跳下一个文件
                        stop_signal.set()
                        return "TIMEOUT"
                    else:
                        time.sleep(5 * retryTime)
                        continue

        if not stop_signal.is_set():
            complete_list.append(partnumber)
            if not dryrun:
                logger.info(
                    f'----->Complete {len(getBody)} Bytes {Src_bucket}/{Src_key}'
                    f' - {partnumber}/{total} {len(complete_list) / total:.2%}')
        else:
            return "TIMEOUT"
        return "COMPLETE"

    # woker_thread END

    # job_processor Main
    partnumber = 1  # 当前循环要上传的Partnumber
    total = len(index_list)
    md5list = [hashlib.md5(b'')] * total
    complete_list = []

    # 线程池
    try:
        stop_signal = threading.Event()  # 用于job_timeout终止当前文件的所有线程
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_thread) as pool:
            # 这里要用迭代器拿到threads对象
            threads = list(thread_gen(woker_thread, pool, stop_signal,
                                      partnumber, total, md5list, partnumber_list, complete_list))

            result = concurrent.futures.wait(
                threads, timeout=job_timeout, return_when="ALL_COMPLETED")

            # 异常退出
            if "QUIT" in [t.result() for t in result[0]]:  # result[0] 是函数done
                logger.warning(
                    f'QUIT. Canceling {len(result[1])} waiting threads in pool ...')
                stop_signal.set()
                for t in result[1]:
                    t.cancel()
                logger.warning(
                    f'QUIT Job: {job["Src_bucket"]}/{job["Src_key"]}')
                return "QUIT"
            # 超时
            if len(result[1]) > 0:  # # result[0] 是函数not_done, 即timeout有未完成的
                logger.warning(
                    f'TIMEOUT. Canceling {len(result[1])} waiting threads in pool ...')
                stop_signal.set()
                for t in result[1]:
                    t.cancel()
                logger.warning(
                    f'TIMEOUT {job_timeout}S Job: {job["Src_bucket"]}/{job["Src_key"]}')
                return "TIMEOUT"

        # 线程池End
        logger.info(
            f'All parts uploaded: {job["Src_bucket"]}/{job["Src_key"]} - Size:{job["Size"]}')

        # 计算所有分片列表的总etag: cal_etag
        digests = b"".join(m.digest() for m in md5list)
        md5full = hashlib.md5(digests)
        cal_etag = '"%s-%s"' % (md5full.hexdigest(), len(md5list))
    except Exception as e:
        logger.error(f'Exception in job_processor: {str(e)}')
        return "ERR"
    return cal_etag
