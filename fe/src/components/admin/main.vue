<template>
  <div>
    <div>
      <el-tag effect="dark" class="my-tag">
        <svg viewBox="0 0 1024 1024" width="20" height="20" style="vertical-align: -4px;">
          <path
            d="M767.1296 808.6528c16.8448 0 32.9728 2.816 48.0256 8.0384 20.6848 7.1168 43.52 1.0752 57.1904-15.9744a459.91936 459.91936 0 0 0 70.5024-122.88c7.8336-20.48 1.0752-43.264-15.9744-57.088-49.6128-40.192-65.0752-125.3888-31.3856-185.856a146.8928 146.8928 0 0 1 30.3104-37.9904c16.2304-14.5408 22.1696-37.376 13.9264-57.6a461.27104 461.27104 0 0 0-67.5328-114.9952c-13.6192-16.9984-36.4544-22.9376-57.0368-15.8208a146.3296 146.3296 0 0 1-48.0256 8.0384c-70.144 0-132.352-50.8928-145.2032-118.7328-4.096-21.6064-20.736-38.5536-42.4448-41.8304-22.0672-3.2768-44.6464-5.0176-67.6864-5.0176-21.4528 0-42.5472 1.536-63.232 4.4032-22.3232 3.1232-40.2432 20.48-43.52 42.752-6.912 46.6944-36.0448 118.016-145.7152 118.4256-17.3056 0.0512-33.8944-2.9696-49.3056-8.448-21.0432-7.4752-44.3904-1.4848-58.368 15.9232A462.14656 462.14656 0 0 0 80.4864 348.16c-7.6288 20.0192-2.7648 43.008 13.4656 56.9344 55.5008 47.8208 71.7824 122.88 37.0688 185.1392a146.72896 146.72896 0 0 1-31.6416 39.168c-16.8448 14.7456-23.0912 38.1952-14.5408 58.9312 16.896 41.0112 39.5776 79.0016 66.9696 113.0496 13.9264 17.3056 37.2736 23.1936 58.2144 15.7184 15.4112-5.4784 32-8.4992 49.3056-8.4992 71.2704 0 124.7744 49.408 142.1312 121.2928 4.9664 20.48 21.4016 36.0448 42.24 39.168 22.2208 3.328 44.9536 5.0688 68.096 5.0688 23.3984 0 46.4384-1.792 68.864-5.1712 21.3504-3.2256 38.144-19.456 42.7008-40.5504 14.8992-68.8128 73.1648-119.7568 143.7696-119.7568z"
            fill="#8C7BFD"></path>
          <path
            d="M511.8464 696.3712c-101.3248 0-183.7568-82.432-183.7568-183.7568s82.432-183.7568 183.7568-183.7568 183.7568 82.432 183.7568 183.7568-82.432 183.7568-183.7568 183.7568z m0-265.1648c-44.8512 0-81.3568 36.5056-81.3568 81.3568S466.9952 593.92 511.8464 593.92s81.3568-36.5056 81.3568-81.3568-36.5056-81.3568-81.3568-81.3568z"
            fill="#FFE37B"></path>
        </svg>
        统计信息
      </el-tag>

      <!-- 一键重建：触发 GitHub Actions 跑完整构建 -->
      <div style="margin: 10px 0 20px; padding: 14px 18px; border-radius: 8px;
                  background: #f7f9fe; border: 1px solid #e4e8f0">
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 12px">
          <span style="font-weight: 600; color: #606266">发布后同步</span>
          <el-button type="primary" size="small" :loading="rebuilding"
                     @click="triggerRebuild">
            {{ rebuilding ? '构建中…' : '重新构建并部署' }}
          </el-button>
          <span v-if="rebuildMsg" :style="{ fontSize: '13px', color: rebuildOk ? '#67C23A' : '#F56C6C' }">
            {{ rebuildMsg }}
          </span>
          <a v-if="rebuildUrl" :href="rebuildUrl" target="_blank"
             style="font-size: 13px; color: var(--themeBackground)">查看进度</a>
        </div>
        <div style="font-size: 12px; color: #909399; margin-top: 6px">
          新增或修改文章后点此，约 3–5 分钟完成。访客一直能立即看到新内容，
          这一步只是让搜索引擎抓到的静态页面也更新。
        </div>
      </div>

      <!-- 总览 -->
      <div>
        <div class="history-title">总览</div>
        <div>
          <div style="margin: 0 auto;display: flex;justify-content: center">
            <div class="history-name" style="line-height: 35px">总访问量:</div>
            <div style="color:var(--maxLightRed);font-weight: bold;font-size: 30px;line-height: 35px">
              {{historyInfo.ip_history_count}}
            </div>
          </div>
          <div class="myCenter">
            <div class="history-info">
              <div>
                <div class="history-name" style="margin-top: 15px">省份访问TOP10</div>
                <div>
                  <el-table :data="historyInfo.ip_history_province">
                    <el-table-column
                      type="index"
                      align="center"
                      width="60">
                    </el-table-column>
                    <el-table-column
                      prop="province"
                      align="center"
                      label="省份"
                      width="140">
                    </el-table-column>
                    <el-table-column
                      prop="num"
                      align="center"
                      label="数量"
                      width="100">
                    </el-table-column>
                  </el-table>
                </div>
              </div>
              <div>
                <div class="history-name" style="margin-top: 15px">IP访问TOP10</div>
                <div>
                  <el-table :data="historyInfo.ip_history_ip">
                    <el-table-column
                      type="index"
                      align="center"
                      width="60">
                    </el-table-column>
                    <el-table-column
                      prop="ip"
                      align="center"
                      label="IP"
                      width="140">
                    </el-table-column>
                    <el-table-column
                      prop="num"
                      align="center"
                      label="数量"
                      width="100">
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 今日访问 -->
      <div>
        <div class="history-title">今日访问</div>
        <div class="myCenter">
          <div>
            <div style="margin: 0 auto;display: flex;justify-content: center">
              <div class="history-name" style="line-height: 35px">今日访问量：</div>
              <div style="color:var(--maxLightRed);font-weight: bold;font-size: 30px;line-height: 35px">
                {{historyInfo.ip_count_today}}
              </div>
            </div>
            <div class="history-info">
              <div>
                <div class="history-name" style="margin-top: 15px">今日访问省份统计</div>
                <div>
                  <el-table :data="historyInfo.province_today">
                    <el-table-column
                      type="index"
                      align="center"
                      width="60">
                    </el-table-column>
                    <el-table-column
                      prop="province"
                      align="center"
                      label="省份"
                      width="140">
                    </el-table-column>
                    <el-table-column
                      prop="num"
                      align="center"
                      label="数量"
                      width="100">
                    </el-table-column>
                  </el-table>
                </div>
              </div>
              <div>
                <div class="history-name" style="margin-top: 15px">今日访问用户</div>
                <div class="history-avatar">
                  <el-table :data="historyInfo.username_today">
                    <el-table-column
                      align="center"
                      label="头像"
                      width="100">
                      <template slot-scope="scope">
                        <el-avatar class="user-avatar" :size="30"
                                   :src="scope.row.avatar">
                        </el-avatar>
                      </template>
                    </el-table-column>
                    <el-table-column
                      prop="username"
                      align="center"
                      label="用户"
                      width="200">
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 昨日访问 -->
      <div>
        <div class="history-title">昨日访问</div>
        <div>
          <div style="margin: 0 auto;display: flex;justify-content: center">
            <div class="history-name" style="line-height: 35px">昨日访问量：</div>
            <div style="color:var(--maxLightRed);font-weight: bold;font-size: 30px;line-height: 35px">
              {{historyInfo.ip_count_yest}}
            </div>
          </div>
          <div class="myCenter">
            <div class="history-info">
              <div>
                <div class="history-name">昨日访问用户</div>
                <div class="history-avatar">
                  <el-table :data="historyInfo.username_yest">
                    <el-table-column
                      align="center"
                      label="头像"
                      width="100">
                      <template slot-scope="scope">
                        <el-avatar class="user-avatar" :size="30"
                                   :src="scope.row.avatar">
                        </el-avatar>
                      </template>
                    </el-table-column>
                    <el-table-column
                      prop="username"
                      align="center"
                      label="用户"
                      width="200">
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
  export default {
    data() {
      return {
        historyInfo: {},
        // 一键重建按钮状态
        rebuilding: false,
        rebuildMsg: '',
        rebuildOk: true,
        rebuildUrl: ''
      }
    },

    computed: {},

    watch: {},

    created() {
      this.getHistoryInfo();
    },

    mounted() {

    },

    methods: {
      /** 触发 GitHub Actions 重建 */
      triggerRebuild() {
        this.rebuilding = true
        this.rebuildMsg = ''
        this.rebuildUrl = ''
        this.$http.post(this.$constant.baseURL.replace('/legacy', '') + '/rebuild', {}, true)
          .then((res) => {
            this.rebuildOk = true
            this.rebuildMsg = res.data.message || '已触发重建'
            this.rebuildUrl = (res.data.url || '').replace('/workflows/deploy-frontend.yml', '')
            this.$message({ message: '已触发重建，约 3-5 分钟后生效', type: 'success' })
          })
          .catch((err) => {
            this.rebuildOk = false
            this.rebuildMsg = err.message || '触发失败'
            this.$message({ message: err.message || '触发失败', type: 'error' })
          })
          .finally(() => { this.rebuilding = false })
      },


      getHistoryInfo() {
        this.$http.get(this.$constant.baseURL + "/webInfo/getHistoryInfo", {}, true)
          .then((res) => {
            if (!this.$common.isEmpty(res.data)) {
              this.historyInfo = res.data;
            }
          })
          .catch((error) => {
            this.$message({
              message: error.message,
              type: "error"
            });
          });
      }
    }
  }
</script>

<style scoped>

  .my-tag {
    width: 100%;
    text-align: left;
    background: var(--lightYellow);
    border: none;
    height: 40px;
    line-height: 40px;
    font-size: 16px;
    color: var(--black);
  }

  .history-title {
    margin: 15px auto 15px;
    text-align: center;
    padding: 10px 20px;
    background: var(--lightGreen);
    color: var(--white);
    font-weight: bold;
    border-radius: 5px;
    width: 150px;
  }

  .history-name {
    font-size: 18px;
    font-weight: bold;
    margin: 0 10px 10px 0;
    text-align: center;
  }

  .history-info {
    display: flex;
    text-align: center;
    margin: 0 auto;
  }

  .history-info >>> .el-table .cell {
    line-height: unset;
  }

  .history-avatar >>> .el-table .el-table__row .el-table__cell {
    padding: 3.5px 0;
  }

  .history-info >>> .el-table::before {
    height: unset;
  }

  @media screen and (max-width: 800px) {
    .history-info {
      display: unset;
    }
  }

</style>
