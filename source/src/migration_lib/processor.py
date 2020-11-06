import threading
import logging
import hashlib
import concurrent
import base64
import time

from migration_lib.client import DownloadClient, UploadClient


logger = logging.getLogger(__name__)


def job_processor(upload_id, index_list, partnumber_list, job, src_client: DownloadClient, des_client: UploadClient,
                  max_thread, chunk_size, max_retry, job_timeout, verify_md5_twice, include_version):
    # a worker thread generator
    def thread_gen(woker_thread, pool,
                   stop_signal, partnumber, total, md5list, partnumber_list, complete_list):
        for partStartIndex in index_list:
            # start to upload part
            if partnumber not in partnumber_list:
                dryrun = False
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

    # an executable worker thread
    def woker_thread(*, stop_signal, partnumber, partStartIndex, total, md5list, dryrun, complete_list):
        if stop_signal.is_set():
            return 'TIMEOUT'
        getBody, chunkdata_md5 = b'', b''  # init

        # start downloading
        if verify_md5_twice or not dryrun:
            if include_version:
                logger.info(f"----->Downloading {chunk_size} Bytes {src_bucket}/{src_key} - {partnumber}/{total}"
                            f" - versionId: {versionId}")
            else:
                logger.info(
                    f"----->Downloading {chunk_size} Bytes {src_bucket}/{src_key} - {partnumber}/{total}")
            retryTime = 0

            # Quit thread if stop_signal is set
            while retryTime <= max_retry and not stop_signal.is_set():
                retryTime += 1
                try:
                    if include_version:
                        getBody, chunkdata_md5 = src_client.get_object(
                            src_key, src_size, partStartIndex, chunk_size, versionId)
                    else:
                        getBody, chunkdata_md5 = src_client.get_object(
                            src_key, src_size, partStartIndex, chunk_size)
                    md5list[partnumber - 1] = chunkdata_md5
                    break  # Download completed, not need to retry.

                except Exception as e:
                    logger.warning(f"Fail to download {src_bucket}/{src_key} - ERR: {str(e)}. "
                                   f"Retry part: {partnumber} - Attempts: {retryTime}")
                    if retryTime >= max_retry:
                        logger.error(
                            f"Quit for Max Download retries: {retryTime} - {src_bucket}/{src_key}")
                        stop_signal.set()
                        return 'QUIT'
                    else:
                        time.sleep(5 * retryTime)
                        continue
        # start uploading
        if not dryrun:
            retryTime = 0
            while retryTime <= max_retry and not stop_signal.is_set():
                retryTime += 1
                try:
                    logger.info(
                        f'----->Uploading {len(getBody)} Bytes {des_bucket}/{des_key} - {partnumber}/{total}')

                    des_client.upload_part(
                        des_key, getBody, chunkdata_md5, partnumber, upload_id)
                    break
                except Exception as e:
                    logger.warning(f"Fail to upload part - {des_bucket}/{des_key} -  {str(e)}, "
                                   f"retry part: {partnumber} Attempts: {retryTime}")
                    if retryTime >= max_retry:
                        logger.error(
                            f"Quit for Max Upload retries: {retryTime} - {des_bucket}/{des_key}")
                        # Set stop signal and quit.
                        stop_signal.set()
                        return 'TIMEOUT'
                    else:
                        time.sleep(5 * retryTime)
                        continue

        if not stop_signal.is_set():
            complete_list.append(partnumber)
            if not dryrun:
                logger.info(
                    f'----->Complete {len(getBody)} Bytes {src_bucket}/{src_key}'
                    f' - {partnumber}/{total} {len(complete_list) / total:.2%}')
        else:
            return 'TIMEOUT'
        return 'COMPLETE'
    # woker_thread END

    # job_processor Main
    partnumber = 1  #
    total = len(index_list)
    md5list = [hashlib.md5(b'')] * total
    complete_list = []

    src_bucket = src_client.bucket_name
    src_key = job['Key']
    src_size = job['Size']
    des_bucket = des_client.bucket_name
    des_key = job['DesKey']
    versionId = job['Version']

    # Execute in thread pool
    try:
        stop_signal = threading.Event()
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_thread) as pool:
            # Get the list of threads.
            threads = list(thread_gen(woker_thread, pool, stop_signal,
                                      partnumber, total, md5list, partnumber_list, complete_list))

            result = concurrent.futures.wait(
                threads, timeout=job_timeout, return_when="ALL_COMPLETED")

            # result[0] contains returned message of the thread.
            if "QUIT" in [t.result() for t in result[0]]:
                logger.warning(
                    f'QUIT. Canceling {len(result[1])} waiting threads in pool ...')
                stop_signal.set()
                for t in result[1]:
                    t.cancel()
                logger.warning(
                    f'QUIT Job: {src_bucket}/{src_key}')
                return "QUIT"
            # For timeout.
            if len(result[1]) > 0:  # If not completed.
                logger.warning(
                    f'TIMEOUT. Canceling {len(result[1])} waiting threads in pool ...')
                stop_signal.set()
                for t in result[1]:
                    t.cancel()
                logger.warning(
                    f'TIMEOUT {job_timeout}S Job: {src_bucket}/{src_key}')
                return "TIMEOUT"

        # ThreadPool End
        logger.info(
            f'All parts uploaded: {src_bucket}/{src_key} - Size:{job["Size"]}')

        # Get etag for the all the uploaded parts.
        digests = b"".join(m.digest() for m in md5list)
        md5full = hashlib.md5(digests)
        cal_etag = '"%s-%s"' % (md5full.hexdigest(), len(md5list))
    except Exception as e:
        logger.error(f'Exception in job_processor: {str(e)}')
        return "ERR"
    return cal_etag
